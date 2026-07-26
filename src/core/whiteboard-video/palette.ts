/**
 * @module core/whiteboard-video/palette
 *
 * 设计稿 §8「色彩方案」+ §3「强调色」的单一来源。
 *
 * ## 为什么要有这一层
 *
 * 之前整套白板只有两个颜色旋钮：`ink`（笔迹主色）和 `accent`（下划线/勾/
 * 光环）。后果是**颜色无法承载语义**——一条要点是"通过"还是"风险"、一个
 * 框是"当前步骤"还是"已废弃"，画面上完全一样，只能靠口播解释。设计稿的
 * 六色板不是为了好看，是为了让"绿=成功、红=风险、黄=注意"这类判断不必说
 * 出口。
 *
 * ## 取舍：语义名，不是颜色名
 *
 * 表里的 key 是 `success` / `danger` 而不是 `green` / `red`。调用点写
 * `role: "danger"` 时，换主题只需改这一张表；写 `color: RED` 就把语义焊死
 * 在了调用点上。代价是多一层间接——但白板元素有几十个调用点，值。
 *
 * ## 取舍：不做运行时主题切换
 *
 * 只导出常量表 + 纯查表函数，没有可变的"当前主题"全局量。帧渲染是纯函数
 * （`svg(t)` 必须逐帧稳定），一个可写的全局主题会让同一时刻渲两次得到不同
 * 结果——这类 bug 在一万六千帧里几乎不可能定位。
 */

/**
 * 语义色角色（设计稿 2.0 §3 八色各自的用途）。
 *
 * 2.0 比 1.0 多了 `accent2`(紫) 与 `info`(青) 两个角色。多出来的两个不是"备用
 * 颜色"，是为了让**并列的多个对象**能各自有身份：讲三条并行路径、画四个模块
 * 的架构图时，六色板要么不够用、要么被迫拿 `success`/`danger` 当装饰色用，
 * 于是绿色红色的"通过/风险"语义被稀释。
 */
export type InkRole =
  /** 主笔迹：正文、标题、框线（设计稿 #222222）. */
  | "ink"
  /** 主强调：标题下划线、当前步骤、指示箭头（#2563EB）. */
  | "primary"
  /** 成功/通过/已完成（#16A34A）. */
  | "success"
  /** 注意/提示/高亮（#F59E0B）. */
  | "warn"
  /** 风险/错误/坑（#EF4444）. */
  | "danger"
  /** 次要信息：注解、辅助线、被弱化的内容（#64748B）. */
  | "muted"
  /** 次强调：与 primary 并列的第二身份（#7C3AED）. */
  | "accent2"
  /** 信息/中性提示：与 primary 同冷调但更轻（#06B6D4）. */
  | "info";

/**
 * 设计稿 2.0 §3 的八色板。值直接取自设计稿标注，不做"微调优化"。
 *
 * 相对 1.0（image1 §8 的六色）整体换过一轮：`#2D2D2D→#222222`、
 * `#4A90E2→#2563EB`、`#2ECC71→#16A34A`、`#F5C542→#F59E0B`、
 * `#E74C3C→#EF4444`、`#7F8C8D→#64748B`，并新增紫与青。
 *
 * 2.0 的值饱和度更高、明度更低（是 Tailwind 那一系的色值），在白板的白底上
 * 对比更足——1.0 的 `#4A90E2` 蓝在投屏亮度下会发灰。
 */
export const PALETTE: Readonly<Record<InkRole, string>> = {
  ink: "#222222",
  primary: "#2563EB",
  success: "#16A34A",
  warn: "#F59E0B",
  danger: "#EF4444",
  muted: "#64748B",
  accent2: "#7C3AED",
  info: "#06B6D4",
};

/** 一整套语义色（八个角色都有值）. */
export type PaletteRoles = Readonly<Record<InkRole, string>>;

/**
 * 深色板面的八色板。
 *
 * ## 为什么必须整套换，而不是只把底色调暗
 *
 * 短视频平台把标题、时长、按钮这些 UI 用**白字**叠在画面上。白板底色是近白的，
 * 于是平台 UI 直接消失——这不是审美问题，观众连"这条视频多长"都看不到。
 * 反过来把板面调暗，深墨（`#222222`）就看不见了：底色和墨色是一对，只换一头
 * 等于把内容擦掉。
 *
 * ## 值是按对比度挑的，不是把亮色调暗
 *
 * 在 `#1E232A` 底上：`ink #F1F5F9` ≈ 14:1（正文），`muted #94A3B8` ≈ 6.5:1
 * （注解仍读得清——原来的 `#64748B` 只有 3:1，小字会糊成一团），
 * `primary #60A5FA` ≈ 7:1（原 `#2563EB` 只有 3.3:1，细笔画在手机上会断）。
 * 绿和红也各提一档：`#16A34A`/`#EF4444` 在深底上偏闷，`#4ADE80`/`#F87171`
 * 保住了"通过 / 风险"的辨识度。
 */
export const DARK_PALETTE: PaletteRoles = {
  ink: "#F1F5F9",
  primary: "#60A5FA",
  success: "#4ADE80",
  warn: "#FBBF24",
  danger: "#F87171",
  muted: "#94A3B8",
  accent2: "#A78BFA",
  info: "#22D3EE",
};

/**
 * 亮色/深色两套语义色的取表函数。
 *
 * 仍然**不做运行时主题切换**（见模块头）：这是纯查表，调用方在一次渲染开始时
 * 取一次、随 ctx 往下传，帧函数看到的是一个不变的对象。
 */
export function rolesFor(dark: boolean): PaletteRoles {
  return dark ? DARK_PALETTE : PALETTE;
}

/** 角色名清单（校验/枚举用；顺序即设计稿 2.0 §3 的排列顺序）. */
export const INK_ROLES: readonly InkRole[] = [
  "ink",
  "primary",
  "success",
  "warn",
  "accent2",
  "danger",
  "info",
  "muted",
];

/**
 * 并列对象的取色顺序（画多条路径 / 多个模块时按序取）。
 *
 * 刻意**不含** `success` / `danger` / `muted`：绿和红要留给"通过/风险"，
 * 灰要留给"次要"。把它们排进轮转序列，等于让第三条分支自带"这条是错的"暗示。
 */
export const SERIES_ROLES: readonly InkRole[] = [
  "primary",
  "warn",
  "accent2",
  "info",
];

/** 第 n 个并列对象的颜色（越界回绕）. */
export function seriesColor(index: number): string {
  const role = SERIES_ROLES[index % SERIES_ROLES.length] ?? "primary";
  return PALETTE[role];
}

/** 角色名 → 颜色。未知角色回退到主笔迹色（宁可画出来，不要缺一笔）. */
export function inkOf(role: InkRole | undefined): string {
  if (role === undefined) return PALETTE.ink;
  return PALETTE[role] ?? PALETTE.ink;
}

/** 是否是合法角色名（供脚本层校验用户输入）. */
export function isInkRole(v: string): v is InkRole {
  return Object.prototype.hasOwnProperty.call(PALETTE, v);
}

// ---- §3 强调色（荧光笔/涂抹笔触） ----

/**
 * 设计稿 2.0 §4 的荧光/涂抹笔触配色。
 *
 * 与 §3 八色板刻意**共用色相**（蓝/绿/黄），但用途不同：八色板画的是笔迹
 * （不透明、细），强调色画的是涂抹（半透明、宽、压在文字下面）。共用色相
 * 让"蓝色下划线"和"蓝色荧光涂抹"读起来是同一件事的两种强度。
 */
export const HIGHLIGHTS = ["primary", "success", "warn"] as const;

export type HighlightRole = (typeof HIGHLIGHTS)[number];

/**
 * 荧光涂抹的不透明度。
 *
 * 0.35 是"能看出是马克笔涂的、但压不住底下的字"的上限——再高黑色文字会
 * 开始发灰（荧光笔是叠色不是覆盖，而 SVG 的 alpha 混合会真的压暗文字）。
 */
export const HIGHLIGHT_OPACITY = 0.35;

/**
 * 深底上的荧光涂抹不透明度。
 *
 * 亮色板上荧光是"压暗一块"（半透明黄压在黑字上，0.35 正好）；深色板上同一个值
 * 会变成一块暗褐，把压在上面的浅色字**对比度拉低**——本来想强调，结果那几个字
 * 反而最难读。深板上的正确做法是只留一层很淡的底（0.15 是"看得出扫过一笔、
 * 不吃字"的上限），强调靠字色而不是靠底色。
 */
export const DARK_HIGHLIGHT_OPACITY = 0.15;

/** 第 n 条强调色（按设计稿 §3 的强调色1/2/3 顺序，越界回绕）. */
export function highlightOf(index: number): string {
  const role = HIGHLIGHTS[index % HIGHLIGHTS.length] ?? "primary";
  return PALETTE[role];
}

// ---- 兼容旧的 ink/accent 双旋钮 ----

/** 一次渲染实际使用的颜色集（由 config 解析后传给各绘制函数）. */
export interface InkPalette {
  /** 主笔迹色. */
  ink: string;
  /** 主强调色. */
  accent: string;
  /** 六色语义板（角色 → 颜色）. */
  roles: Readonly<Record<InkRole, string>>;
}

/**
 * 设计稿默认配色：主笔迹 = 近黑，主强调 = 蓝。
 *
 * 强调色定为**蓝**而不是之前的砖红 `#c8483a`：设计稿全篇（标题下划线、
 * 板块标签、流程箭头、页脚）都是蓝色，红色在六色板里被指派给"风险/错误"。
 * 把红色同时用作"通用强调"会让每个标题下划线都带一层警告意味。
 */
export function defaultPalette(): InkPalette {
  return { ink: PALETTE.ink, accent: PALETTE.primary, roles: PALETTE };
}

/** 用显式 ink/accent 覆盖默认（CLI `--ink` / `--accent` 仍然可用）. */
export function paletteWith(ink?: string, accent?: string): InkPalette {
  const base = defaultPalette();
  return {
    ink: ink ?? base.ink,
    accent: accent ?? base.accent,
    roles: {
      ...PALETTE,
      ink: ink ?? PALETTE.ink,
      primary: accent ?? PALETTE.primary,
    },
  };
}
