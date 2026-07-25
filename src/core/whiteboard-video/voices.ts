/**
 * PoC: 音色库 —— 按"什么片子用什么声音"编排，而不是按音色名记
 *
 * 数据不是我编的：Edge 的音色表本身带 `Gender` / `ContentCategories` /
 * `VoicePersonalities`（`new MsEdgeTTS().getVoices()` 可查，322 条，其中
 * 中文 14 条 + 多语 12 条）。本模块做两件事：
 * 1. 把能用的那些**按用途**整理成一张表，脚本里引 `id` 而不是 `ShortName`
 *    —— 将来换 TTS 后端（Azure 付费 / MiniMax / ElevenLabs）只改这张表；
 * 2. 补上官方表里没有的东西：年龄段、一句话适用场景、该音色的默认韵律。
 *
 * ## 情绪：Edge 免费端点不支持 express-as
 *
 * 实测（`rawToStream` 直接送 SSML）：
 * ```
 * plain  → 51552 bytes
 * styled → ERR Stream closed before the synthesis completed
 * ```
 * `<mstts:express-as style="sad">` 会让连接直接断。也就是说 Azure 那套
 * 情绪标签在免费通道上**没有**。所以这里的"情绪"只能靠两件事叠出来：
 * - **挑音色**：官方 personality 已经把基调定了（Passion / Warm /
 *   Professional / Cute / Humorous…），选对音色比调参管用得多；
 * - **调韵律**：rate / pitch / volume 是免费通道支持的，见
 *   {@link EMOTION_PRESETS}。
 *
 * 真要精细情绪（同一个音色又哭又笑），得换付费后端。那时候只需要给
 * VoiceSpec 加一个 `styles?: string[]` 字段，调用侧不用动。
 *
 * ## 一条视频两个人说话
 *
 * `CAST_PRESETS` 是成组的角色→音色映射。分两个人说话不是为了花哨：讲解片
 * 里"提问"和"回答"用同一个声音，观众分不清那句是设问还是结论。换个声音
 * 提问，等于免费得到一层结构。
 */

/** 性别（官方表里有）. */
export type Gender = "male" | "female";

/** 年龄段（官方表没有，听感标注）. */
export type AgeBand = "child" | "young" | "adult" | "mature";

/** 韵律（Edge 免费通道支持的全部可调项）. */
export interface Prosody {
  /** 语速，如 `"-8%"` / `"slow"`. */
  rate?: string;
  /** 音高，如 `"+2st"` / `"low"`. */
  pitch?: string;
  /** 音量，如 `"+10%"`. */
  volume?: string;
}

export interface VoiceSpec {
  /** 库内 id —— 脚本里引这个，不要引 shortName. */
  id: string;
  /** 后端音色名（Edge ShortName）. */
  shortName: string;
  gender: Gender;
  age: AgeBand;
  /** 官方 VoicePersonalities. */
  personality: string[];
  /** 官方 ContentCategories. */
  categories: string[];
  /** 一句话说清什么片子该用它. */
  useFor: string;
  /** 该音色的默认韵律（多数讲解片要比出厂语速慢一点）. */
  prosody?: Prosody;
  /** 多语音色：能读中文以外的语言，也能读中文（音色更"外语腔"）. */
  multilingual?: boolean;
}

/**
 * 音色库。
 *
 * 只收**实际听过、能用在成片里**的。Edge 中文一共 14 条，这里收了 11 条；
 * 没收的是 zh-HK-HiuGaai（与 HiuMaan 太像）和两条 zh-TW 女声（同上）。
 * 多语音色收 4 条 en-US Multilingual —— 它们读中文有轻微外语腔，正好用在
 * "国际化/技术前沿"这类调性，或者直接出外语版。
 */
export const VOICE_LIBRARY: readonly VoiceSpec[] = [
  // —— 中文男声 ——
  {
    id: "narrator-male-steady",
    shortName: "zh-CN-YunjianNeural",
    gender: "male",
    age: "adult",
    personality: ["Passion"],
    categories: ["Sports", "Novel"],
    useFor:
      "技术叙述 / 讲道理。句间停顿比别的音色长一点，正好给笔留出写字的时间",
    prosody: { rate: "-4%" },
  },
  {
    id: "news-male-formal",
    shortName: "zh-CN-YunyangNeural",
    gender: "male",
    age: "mature",
    personality: ["Professional", "Reliable"],
    categories: ["News"],
    useFor: "长横版正式教程 / 企业内容。播音腔，可信度最高，但不适合短视频",
    prosody: { rate: "-6%" },
  },
  {
    id: "narrator-male-lively",
    shortName: "zh-CN-YunxiNeural",
    gender: "male",
    age: "young",
    personality: ["Lively", "Sunshine"],
    categories: ["Novel"],
    useFor: "竖版科普短视频。节奏快、上扬，适合 60 秒内讲完一件事",
    prosody: { rate: "+4%" },
  },
  {
    id: "kid-male-cute",
    shortName: "zh-CN-YunxiaNeural",
    gender: "male",
    age: "child",
    personality: ["Cute"],
    categories: ["Cartoon", "Novel"],
    useFor: "儿童内容 / 卡通旁白 / 扮演'提问的学生'",
  },
  // —— 中文女声 ——
  {
    id: "narrator-female-warm",
    shortName: "zh-CN-XiaoxiaoNeural",
    gender: "female",
    age: "adult",
    personality: ["Warm"],
    categories: ["News", "Novel"],
    useFor: "通用旁白。最稳也最'标准'，代价是最容易被听出是 TTS",
    prosody: { rate: "-4%" },
  },
  {
    id: "narrator-female-lively",
    shortName: "zh-CN-XiaoyiNeural",
    gender: "female",
    age: "young",
    personality: ["Lively"],
    categories: ["Cartoon", "Novel"],
    useFor: "带货 / 生活方式 / 情绪外放的短视频",
    prosody: { rate: "+3%" },
  },
  {
    id: "dialect-female-humor",
    shortName: "zh-CN-liaoning-XiaobeiNeural",
    gender: "female",
    age: "adult",
    personality: ["Humorous"],
    categories: ["Dialect"],
    useFor: "东北话。吐槽 / 段子 / 接地气的对比桥段，一句就能带出喜剧感",
  },
  {
    id: "dialect-female-bright",
    shortName: "zh-CN-shaanxi-XiaoniNeural",
    gender: "female",
    age: "young",
    personality: ["Bright"],
    categories: ["Dialect"],
    useFor: "陕西话。地域内容 / 需要'另一个人插话'时的第二个声音",
  },
  // —— 港台 ——
  {
    id: "hk-female-friendly",
    shortName: "zh-HK-HiuMaanNeural",
    gender: "female",
    age: "adult",
    personality: ["Friendly", "Positive"],
    categories: ["General"],
    useFor: "粤语版",
  },
  {
    id: "tw-male-friendly",
    shortName: "zh-TW-YunJheNeural",
    gender: "male",
    age: "adult",
    personality: ["Friendly", "Positive"],
    categories: ["General"],
    useFor: "台湾腔中文版",
  },
  // —— 多语（读中文带轻微外语腔，也可直接出外语版） ——
  {
    id: "multi-male-warm",
    shortName: "en-US-AndrewMultilingualNeural",
    gender: "male",
    age: "adult",
    personality: ["Warm", "Confident", "Authentic", "Honest"],
    categories: ["Conversation", "Copilot"],
    useFor: "中英混排的技术内容 / 出英文版；读中文比 zh-CN 音色略慢",
    prosody: { rate: "-3%" },
    multilingual: true,
  },
  {
    id: "multi-female-expressive",
    shortName: "en-US-AvaMultilingualNeural",
    gender: "female",
    age: "adult",
    personality: ["Expressive", "Caring", "Pleasant", "Friendly"],
    categories: ["Conversation", "Copilot"],
    useFor: "表现力最强的一条，适合需要情绪起伏的叙事段",
    multilingual: true,
  },
  {
    id: "multi-female-clear",
    shortName: "en-US-EmmaMultilingualNeural",
    gender: "female",
    age: "young",
    personality: ["Cheerful", "Clear", "Conversational"],
    categories: ["Conversation", "Copilot"],
    useFor: "口语感强、咬字清楚，适合教程步骤朗读",
    multilingual: true,
  },
  {
    id: "multi-male-casual",
    shortName: "en-US-BrianMultilingualNeural",
    gender: "male",
    age: "young",
    personality: ["Approachable", "Casual", "Sincere"],
    categories: ["Conversation", "Copilot"],
    useFor: "轻松的第二人称口吻，适合'我们一起来看'这种带入式讲解",
    multilingual: true,
  },
] as const;

/** 情绪（免费通道只能用韵律近似，见模块注释）. */
export type Emotion =
  "neutral" | "calm" | "upbeat" | "serious" | "gentle" | "urgent" | "question";

/**
 * 情绪 → 韵律偏移（叠加在音色自带韵律之上）。
 *
 * 幅度都很小：rate 超过 ±12%、pitch 超过 ±3st 就开始有电子音，反而更假。
 * 真正决定"听起来什么情绪"的是选哪个音色。
 */
export const EMOTION_PRESETS: Record<Emotion, Prosody> = {
  neutral: {},
  /** 更慢更低：结论、定义、需要观众记住的句子. */
  calm: { rate: "-8%", pitch: "-1st" },
  /** 更快更高：开场钩子、好消息、转折后的推进. */
  upbeat: { rate: "+8%", pitch: "+1st" },
  /**
   * 慢而低、音量略提：警告、代价、"这里有个坑"。
   *
   * pitch 只降 1 度。降 2 度在**本来就低的男声**上（YunyangNeural 这种播音
   * 腔）会把声音压得发闷、字咬不清——实测长教程里连着几段 serious 之后
   * 观众听不清在说什么。真要更"重"，靠放慢和提音量，不要再往下压音高。
   */
  serious: { rate: "-10%", pitch: "-1st", volume: "+6%" },
  /** 慢而轻：安慰、过渡、"别担心". */
  gentle: { rate: "-6%", volume: "-8%" },
  /** 快：紧迫感、时间压力. */
  urgent: { rate: "+14%" },
  /** 略快略高：设问句（"真的只能这样吗？"）. */
  question: { rate: "+4%", pitch: "+2st" },
};

/** 视频体裁 → 默认旁白音色（长片正式、短片活泼）. */
export const KIND_DEFAULT_VOICE = {
  /** 3 分钟内的竖版短视频. */
  short: "narrator-male-lively",
  /** 3 分钟以上的横版详细教程. */
  long: "news-male-formal",
} as const;

/**
 * 对话预设：角色名 → 音色 id。
 *
 * 角色名是**中文**且直接出现在脚本里（`主讲：…`），所以要短、要一眼分清。
 */
export const CAST_PRESETS: Record<string, Record<string, string>> = {
  /** 单人旁白（默认）. */
  solo: { 旁白: "narrator-male-steady" },
  /** 访谈式：正式主讲 + 女声提问，最适合"设问—回答"结构的教程. */
  interview: { 主讲: "news-male-formal", 提问: "narrator-female-warm" },
  /**
   * 清亮女声主讲 + 年轻男声提问 —— **长教程默认用这套**。
   *
   * `interview` 的深音色男声主讲在长片里有个实际问题：讲坑的段落大量用
   * serious，低音色再压音高就发闷、字咬不清。女声主讲的中高频更容易听清，
   * 尤其在手机小喇叭和会议室投屏上。
   */
  "interview-female": {
    主讲: "narrator-female-warm",
    提问: "narrator-male-lively",
  },
  /** 双主播闲聊：两个年轻声音，适合竖版轻内容. */
  duo: { 甲: "narrator-male-lively", 乙: "narrator-female-lively" },
  /** 师生：老师正式 + 学生童声，用于"学生犯的错"这类桥段. */
  class: { 老师: "news-male-formal", 学生: "kid-male-cute" },
  /** 吐槽：正经旁白 + 东北话插话，喜剧对比. */
  banter: { 旁白: "narrator-male-steady", 吐槽: "dialect-female-humor" },
};

/** 按 id 取音色. @throws Error id 不在库里（拼错要立刻炸，不要静默回退） */
export function findVoice(id: string): VoiceSpec {
  const hit = VOICE_LIBRARY.find((v) => v.id === id);
  if (hit === undefined) {
    throw new Error(
      `音色库里没有 "${id}"。可选：${VOICE_LIBRARY.map((v) => v.id).join(", ")}`,
    );
  }
  return hit;
}

export interface VoiceQuery {
  gender?: Gender;
  age?: AgeBand;
  /** 匹配 personality（不区分大小写、子串命中即可）. */
  tone?: string;
  /** 匹配 categories. */
  category?: string;
  /** 是否要多语音色. */
  multilingual?: boolean;
}

/**
 * 按条件挑音色（条件越多越窄，全不命中返回 null）。
 *
 * 给 LLM 用的入口：它读完文章知道调性（"这是个严肃的技术教程"），但不该
 * 记住 `zh-CN-YunyangNeural` 这种名字。
 */
export function pickVoice(q: VoiceQuery): VoiceSpec | null {
  const tone = q.tone?.toLowerCase();
  const cat = q.category?.toLowerCase();
  const hits = VOICE_LIBRARY.filter((v) => {
    if (q.gender !== undefined && v.gender !== q.gender) return false;
    if (q.age !== undefined && v.age !== q.age) return false;
    if (
      q.multilingual !== undefined &&
      (v.multilingual ?? false) !== q.multilingual
    ) {
      return false;
    }
    if (
      tone !== undefined &&
      !v.personality.some((p) => p.toLowerCase().includes(tone))
    ) {
      return false;
    }
    if (
      cat !== undefined &&
      !v.categories.some((c) => c.toLowerCase().includes(cat))
    ) {
      return false;
    }
    return true;
  });
  return hits[0] ?? null;
}

/** 音色自带韵律 + 情绪偏移合并（情绪覆盖同名项）. */
export function voiceProsody(
  v: VoiceSpec,
  emotion: Emotion = "neutral",
): Prosody {
  return { ...(v.prosody ?? {}), ...EMOTION_PRESETS[emotion] };
}
