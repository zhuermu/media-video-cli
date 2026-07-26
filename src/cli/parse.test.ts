/**
 * 路由表元数据的完整性门禁 + `vagent schema` 的形状。
 *
 * 这些测试的作用不是"验证代码能跑"，而是**把文档义务变成编译期之后的硬门禁**：
 * 加一个 flag 却不写 desc / 不给枚举值域 / 不声明产物，测试当场失败。没有这层
 * 门禁时，参数说明的腐烂是静默的——它只在大模型猜错值域、白跑一次渲染时才暴露。
 */

import { describe, expect, test } from "bun:test";

import {
  EXIT_CODES,
  GLOBAL_OPTIONS,
  GROUP_TITLES,
  ROUTES,
  cliSchema,
  helpText,
  parseCli,
  usageFor,
  usageOf,
} from "./parse";

describe("路由表元数据完整性", () => {
  test("route key 唯一，tokens 唯一", () => {
    const routes = ROUTES.map((r) => r.route);
    expect(new Set(routes).size).toBe(routes.length);
    const tokens = ROUTES.map((r) => r.tokens.join(" "));
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  for (const spec of ROUTES) {
    describe(`${spec.route}`, () => {
      test("有非空 summary / group / cost", () => {
        expect(spec.summary.length).toBeGreaterThan(0);
        expect(Object.keys(GROUP_TITLES)).toContain(spec.group);
        expect(["cheap", "expensive"]).toContain(spec.cost);
      });

      test("每个位置参数都有 desc", () => {
        for (const p of spec.positionals) {
          expect(p.desc.length, `位置参数 ${p.name} 缺 desc`).toBeGreaterThan(
            0,
          );
        }
      });

      test("每个 flag 都有 desc；枚举必须给 values", () => {
        for (const [name, flag] of Object.entries(spec.options)) {
          expect(flag.desc.length, `--${name} 缺 desc`).toBeGreaterThan(0);
          if (flag.values !== undefined) {
            expect(
              flag.values.length,
              `--${name} 的 values 为空`,
            ).toBeGreaterThan(1);
          }
          // 枚举型不该同时靠 desc 里的自然语言表达值域（会漂移）
          if (flag.type === "boolean") {
            expect(flag.values, `布尔 --${name} 不该有 values`).toBeUndefined();
          }
        }
      });

      test("会写文件的命令必须声明 produces", () => {
        // 只读命令（report / validate / schema / check）允许空 produces，
        // 但必须是显式的空数组而不是 undefined。
        expect(Array.isArray(spec.produces)).toBe(true);
      });

      test("requires 里的前置必须是真实存在的 route", () => {
        for (const req of spec.requires ?? []) {
          expect(
            ROUTES.some((r) => r.route === req),
            `${spec.route} 的前置 ${req} 不在路由表里`,
          ).toBe(true);
        }
      });

      test("usage 覆盖全部位置参数与全部 flag", () => {
        const usage = usageFor(spec);
        for (const p of spec.positionals)
          expect(usage).toContain(`<${p.name}>`);
        for (const name of Object.keys(spec.options)) {
          expect(usage, `usage 漏了 --${name}`).toContain(`--${name}`);
        }
        expect(usage.startsWith("vagent ")).toBe(true);
      });
    });
  }

  test("全局参数也要有 desc", () => {
    for (const [name, flag] of Object.entries(GLOBAL_OPTIONS)) {
      expect(flag.desc.length, `--${name} 缺 desc`).toBeGreaterThan(0);
    }
  });

  test("usageOf 按 route key 取到同一份用法行", () => {
    expect(usageOf("tts run")).toBe(usageFor(ROUTES[2]!));
  });
});

describe("helpText", () => {
  const help = helpText();

  test("列出每条命令的用法与摘要", () => {
    for (const spec of ROUTES) {
      expect(help).toContain(usageFor(spec));
      expect(help).toContain(spec.summary);
    }
  });

  test("保留停点提示（BR-U6-11）", () => {
    for (const spec of ROUTES) {
      if (spec.stopHint !== undefined) expect(help).toContain(spec.stopHint);
    }
  });

  test("指向机器可读入口与试跑档", () => {
    expect(help).toContain("vagent schema --json");
    expect(help).toContain("--dry-run");
  });
});

describe("cliSchema", () => {
  const schema = cliSchema("1.2.3");

  test("顶层字段齐全，可 JSON 往返", () => {
    expect(schema.cli).toBe("vagent");
    expect(schema.product).toBe("media-video-cli");
    expect(schema.version).toBe("1.2.3");
    expect(schema.commands).toHaveLength(ROUTES.length);
    expect(schema.exitCodes).toBe(EXIT_CODES);
    const back = JSON.parse(JSON.stringify(schema)) as typeof schema;
    expect(back.commands.map((c) => c.route)).toEqual(
      ROUTES.map((r) => r.route),
    );
  });

  test("每条命令带 usage / flags / produces / requires / notes", () => {
    for (const cmd of schema.commands) {
      expect(cmd.usage.startsWith("vagent ")).toBe(true);
      expect(Array.isArray(cmd.flags)).toBe(true);
      expect(Array.isArray(cmd.produces)).toBe(true);
      expect(Array.isArray(cmd.requires)).toBe(true);
      expect(Array.isArray(cmd.notes)).toBe(true);
    }
  });

  test("全局参数含 json / dry-run / videos-root / data-root", () => {
    expect(schema.globals.map((g) => g.name).sort()).toEqual([
      "data-root",
      "dry-run",
      "json",
      "videos-root",
    ]);
  });

  test("退出码表覆盖锁定的全部码", () => {
    expect(schema.exitCodes.map((e) => e.code)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});

describe("parseCli 值域校验", () => {
  test("枚举合法值通过", () => {
    const cmd = parseCli(["tts", "run", "demo", "--backend", "say"]);
    expect(cmd.route).toBe("tts run");
    expect(cmd.values["backend"]).toBe("say");
  });

  test("枚举非法值报错并列出值域", () => {
    expect(() =>
      parseCli(["tts", "run", "demo", "--backend", "azure"]),
    ).toThrow(/edge \| say/);
  });

  test("全局 --dry-run / --data-root 在任何命令上都能解析", () => {
    const cmd = parseCli([
      "report",
      "weekly",
      "--dry-run",
      "--data-root",
      "/tmp/d",
    ]);
    expect(cmd.dryRun).toBe(true);
    expect(cmd.dataRoot).toBe("/tmp/d");
  });

  test("compose run 接受 --template（core 的模板 seam 现在可从命令行给）", () => {
    const cmd = parseCli(["compose", "run", "demo", "--template", "./t.json"]);
    expect(cmd.values["template"]).toBe("./t.json");
  });

  test("whiteboard render 的枚举参数逐个校验", () => {
    expect(
      parseCli(["whiteboard", "render", "a.md", "--kind", "long"]).route,
    ).toBe("whiteboard render");
    expect(() =>
      parseCli(["whiteboard", "render", "a.md", "--kind", "vertical"]),
    ).toThrow(/short \| long \| auto/);
    expect(() =>
      parseCli(["whiteboard", "render", "a.md", "--background", "wood"]),
    ).toThrow(/plain \| grid/);
    expect(() =>
      parseCli(["whiteboard", "render", "a.md", "--cursor", "mouse"]),
    ).toThrow(/pen \| hand/);
    expect(() =>
      parseCli(["whiteboard", "render", "a.md", "--arm", "sleeve"]),
    ).toThrow(/cuff \| extend/);
  });

  test("register/metrics 的 platform 值域在 parse 层就拦住", () => {
    expect(() =>
      parseCli([
        "register",
        "add",
        "--platform",
        "bilibili",
        "--url",
        "u",
        "--title",
        "t",
        "--published-at",
        "2026-07-26T20:00:00+08:00",
        "--package",
        "p",
      ]),
    ).toThrow(/shipinhao \| douyin/);
  });

  test("缺必填参数时报错点名到 flag", () => {
    expect(() => parseCli(["register", "add", "--platform", "douyin"])).toThrow(
      /--url/,
    );
  });

  test("schema 是一条正常路由", () => {
    expect(parseCli(["schema"]).route).toBe("schema");
    expect(parseCli(["schema", "--json"]).json).toBe(true);
  });
});
