/**
 * @module core/whiteboard-video/inline-marks
 *
 * 要点行里的**行内标记** → 纯文本 + 强调区间。
 *
 * ## 为什么只有要点行有行内标记
 *
 * 普通段落是口播台词，它进的是配音；在台词里写 `==高亮==` 只会让 TTS 把
 * 等号念出来，或者迫使渲染层去猜哪部分是画面指令。要点行不同——它本来就是
 * **板上的字**，给它加"这几个字要强调"的标记，语义是连贯的。
 *
 * ## 三种标记与它们对应的设计稿板块
 *
 * | 写法 | 画面 | 板块 |
 * |------|------|------|
 * | `==文本==` | 荧光笔涂抹（半透明色带刷过） | §4 荧光笔效果 / §13 高亮背景 |
 * | `**文本**` | 文字下方一条紧贴的强调线 | §12 强调线 / §13 重点文字 |
 * | `((文本))` | 手绘椭圆把这几个字圈起来 | §13 手绘圈图 |
 *
 * 位置用**字符下标**而不是像素：排版字号在 compose 里才确定（受栏宽和文案长度
 * 影响），解析层给不出像素。渲染层用 `textWidth(前缀)` 把下标换成 x。
 */

import { ValidationError } from "../errors/index";

/** 行内标记类型. */
export type MarkKind = "highlight" | "key" | "circle";

/** 一个强调区间（下标是**去掉标记后**纯文本里的字符位置，[from, to) ）. */
export interface InlineMark {
  kind: MarkKind;
  from: number;
  to: number;
}

/** 拆解结果. */
export interface MarkedText {
  /** 去掉标记符号后的文本（板上真正写出来的字）. */
  text: string;
  marks: InlineMark[];
}

const RULES: ReadonlyArray<{ kind: MarkKind; open: string; close: string }> = [
  { kind: "highlight", open: "==", close: "==" },
  { kind: "key", open: "**", close: "**" },
  { kind: "circle", open: "((", close: "))" },
];

/**
 * 拆出行内标记。
 *
 * 不做嵌套：`==**字**==` 这种组合在白板上是"涂了色又划了线"，画面语义含混，
 * 而且两条几何都要按同一段字定位、互相压住。遇到嵌套**当场报错**要求作者选
 * 一种，而不是任选其一静默生效。
 *
 * 未闭合的标记同样报错：静默当成普通文字会让板上出现两个等号，作者只能靠看
 * 成片才发现。
 *
 * @throws ValidationError 标记未闭合 / 标记嵌套
 */
export function parseInlineMarks(raw: string): MarkedText {
  const chars = [...raw];
  const out: string[] = [];
  const marks: InlineMark[] = [];
  let open: { kind: MarkKind; close: string; from: number } | null = null;
  let i = 0;
  while (i < chars.length) {
    const two = chars[i]! + (chars[i + 1] ?? "");
    if (open !== null && two === open.close) {
      if (out.length === open.from) {
        throw new ValidationError(`行内标记里没有文字：${raw}`);
      }
      marks.push({ kind: open.kind, from: open.from, to: out.length });
      open = null;
      i += 2;
      continue;
    }
    const rule = RULES.find((r) => r.open === two);
    if (rule !== undefined) {
      if (open !== null) {
        throw new ValidationError(
          `行内标记不能嵌套（${open.kind} 里又开了 ${rule.kind}）：${raw}。` +
            `涂色和划线叠在同一段字上，画面读不出强调的是哪个`,
        );
      }
      open = { kind: rule.kind, close: rule.close, from: out.length };
      i += 2;
      continue;
    }
    out.push(chars[i]!);
    i += 1;
  }
  if (open !== null) {
    throw new ValidationError(
      `行内标记 ${open.kind} 没有闭合：${raw}（成对写法：==…== / **…** / ((…)) ）`,
    );
  }
  return { text: out.join(""), marks };
}

/** 这一行有没有行内标记（供调用方省掉无标记时的额外计算）. */
export function hasInlineMarks(raw: string): boolean {
  return RULES.some((r) => raw.includes(r.open));
}
