/**
 * Offline tests for the paid MiniMax backend (fake `fetch`, zero network,
 * zero spend).
 *
 * 这个后端在覆盖率分母之外（子进程/外部调用胶水层），但仍然值得测：它的两层
 * 失败判定（HTTP 状态码 + 响应体里的 `base_resp.status_code`）是纯逻辑，而
 * 判错的代价是真金白银——把「余额不足」当成成功会写出一个空音频文件，然后在
 * 拼接阶段以一个完全无关的 ffmpeg 错误暴露出来。
 */
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { redact, type MinimaxConfig } from "@core/config";
import {
  TTSBackendError,
  TTSMalformedOutputError,
  TTSNetworkError,
  TTSRateLimitError,
} from "@core/errors";

import { MINIMAX_TEXT_LIMIT, MinimaxTtsBackend } from "./minimax";

const config: MinimaxConfig = {
  apiKey: "fake-minimax-key-0123456789",
  baseUrl: "https://api.minimaxi.com",
  model: "speech-2.6-hd",
  voice: "male-qn-jingying",
  speed: 1,
};

/** 一次调用的记录 + 可编排的响应. */
function fakeFetch(respond: () => Response | Promise<Response> | never): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** `data.audio` 是 hex 编码的音频字节. */
function okBody(audio: string, usageCharacters = 12): unknown {
  return {
    data: { audio: Buffer.from(audio).toString("hex"), status: 2 },
    extra_info: { usage_characters: usageCharacters, audio_length: 3200 },
    trace_id: "trace-abc",
    base_resp: { status_code: 0, status_msg: "success" },
  };
}

function backendWith(
  respond: () => Response | Promise<Response> | never,
  overrides: Partial<MinimaxConfig> = {},
) {
  const { fetchFn, calls } = fakeFetch(respond);
  return {
    backend: new MinimaxTtsBackend({
      config: { ...config, ...overrides },
      fetchFn,
    }),
    calls,
  };
}

describe("MinimaxTtsBackend 正常路径", () => {
  test("hex 音频落成 mp3 临时文件，计费口径累计", async () => {
    const { backend, calls } = backendWith(() =>
      jsonResponse(okBody("ID3-fake-audio")),
    );

    const first = await backend.synthesize("第一段口播", {
      name: "male-qn-jingying",
      segmentIndex: 0,
    });
    expect(readFileSync(first.path, "utf8")).toBe("ID3-fake-audio");
    expect(first.path.endsWith(".mp3")).toBe(true);
    // 时长一律留给 ffprobe 实测（BR-U2-3）
    expect(first.durationSec).toBe(0);
    expect(backend.usage).toEqual({ characters: 12, requests: 1 });

    await backend.synthesize("第二段口播", { name: "male-qn-jingying" });
    expect(backend.usage).toEqual({ characters: 24, requests: 2 });
    expect(calls).toHaveLength(2);
  });

  test("请求形状：同步接口 + hex 输出 + 音色/语速/模型 都按配置来", async () => {
    const { backend, calls } = backendWith(() => jsonResponse(okBody("x")), {
      model: "speech-2.8-hd",
      speed: 1.15,
    });
    await backend.synthesize("你好", { name: "female-yujie", segmentIndex: 3 });

    const call = calls[0]!;
    expect(call.url).toBe("https://api.minimaxi.com/v1/t2a_v2");
    expect((call.init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${config.apiKey}`,
    );
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("speech-2.8-hd");
    expect(body["text"]).toBe("你好");
    expect(body["stream"]).toBe(false);
    expect(body["output_format"]).toBe("hex");
    expect(body["voice_setting"]).toMatchObject({
      voice_id: "female-yujie",
      speed: 1.15,
    });
    expect(body["audio_setting"]).toMatchObject({ format: "mp3" });
  });

  test("GroupId 只在配置里给了才作为查询参数带上", async () => {
    const without = backendWith(() => jsonResponse(okBody("x")));
    await without.backend.synthesize("t", { name: "v" });
    expect(without.calls[0]!.url).not.toContain("GroupId");

    const with_ = backendWith(() => jsonResponse(okBody("x")), {
      groupId: "1900000001",
    });
    await with_.backend.synthesize("t", { name: "v" });
    expect(with_.calls[0]!.url).toContain("?GroupId=1900000001");
  });
});

describe("MinimaxTtsBackend 入参校验（花钱之前）", () => {
  test("空文本 / 空音色 / 超长文本都不会发出请求", async () => {
    const { backend, calls } = backendWith(() => jsonResponse(okBody("x")));
    await expect(
      backend.synthesize("   ", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSBackendError);
    await expect(backend.synthesize("t", { name: " " })).rejects.toBeInstanceOf(
      TTSBackendError,
    );
    await expect(
      backend.synthesize("字".repeat(MINIMAX_TEXT_LIMIT + 1), { name: "v" }),
    ).rejects.toThrow(/上限/);
    expect(calls).toHaveLength(0);
    expect(backend.usage).toEqual({ characters: 0, requests: 0 });
  });
});

describe("MinimaxTtsBackend 错误分类", () => {
  test("HTTP 429 / 5xx / 4xx 分别映射到限流 / 网络 / 后端错误", async () => {
    const rate = backendWith(() => jsonResponse({ msg: "too many" }, 429));
    await expect(
      rate.backend.synthesize("t", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSRateLimitError);

    const server = backendWith(() => jsonResponse({ msg: "boom" }, 503));
    await expect(
      server.backend.synthesize("t", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSNetworkError);

    const client = backendWith(() => jsonResponse({ msg: "nope" }, 401));
    await expect(
      client.backend.synthesize("t", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSBackendError);
  });

  test("HTTP 200 但 base_resp 非 0 也是失败（余额不足带可操作提示）", async () => {
    const { backend } = backendWith(() =>
      jsonResponse({
        data: null,
        base_resp: { status_code: 1008, status_msg: "insufficient balance" },
      }),
    );
    await expect(backend.synthesize("t", { name: "v" })).rejects.toBeInstanceOf(
      TTSBackendError,
    );
    try {
      await backend.synthesize("t", { name: "v" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("1008");
      expect((error as Error).message).toContain("余额");
      expect((error as Error).message).toContain("--backend edge");
    }
    // 失败的请求不进账单口径
    expect(backend.usage).toEqual({ characters: 0, requests: 0 });
  });

  test("限流码可退避、服务端码可重试、鉴权码不可重试", async () => {
    const cases: Array<[number, unknown]> = [
      [1002, TTSRateLimitError],
      [2056, TTSRateLimitError],
      [1001, TTSNetworkError],
      [1033, TTSNetworkError],
      [1004, TTSBackendError],
      [2013, TTSBackendError],
    ];
    for (const [code, expected] of cases) {
      const { backend } = backendWith(() =>
        jsonResponse({ base_resp: { status_code: code, status_msg: "e" } }),
      );
      await expect(
        backend.synthesize("t", { name: "v" }),
      ).rejects.toBeInstanceOf(expected as never);
    }
  });

  test("空音频 / 非法 JSON → 输出格式错误", async () => {
    const empty = backendWith(() =>
      jsonResponse({ data: { audio: "" }, base_resp: { status_code: 0 } }),
    );
    await expect(
      empty.backend.synthesize("t", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSMalformedOutputError);

    const junk = backendWith(
      () => new Response("<html>502</html>", { status: 200 }),
    );
    await expect(
      junk.backend.synthesize("t", { name: "v" }),
    ).rejects.toBeInstanceOf(TTSMalformedOutputError);
  });

  test("传输层异常（超时/断连）算网络类，可被上层重试策略吃掉", async () => {
    const { backend } = backendWith(() => {
      throw new Error("The operation timed out.");
    });
    const error = await backend
      .synthesize("t", { name: "v", segmentIndex: 2 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TTSNetworkError);
    expect((error as TTSNetworkError).segmentIndex).toBe(2);
    expect((error as TTSNetworkError).backend).toBe("minimax");
  });

  test("凭据不会出现在错误信息里（BR-U1-7）", async () => {
    const { backend } = backendWith(() =>
      jsonResponse({ msg: `bad key ${config.apiKey}` }, 401),
    );
    const error = await backend
      .synthesize("t", { name: "v" })
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(config.apiKey);
    expect(redact((error as Error).message)).toBe((error as Error).message);
  });
});
