/**
 * @module core/whiteboard-video/log
 *
 * 进度日志的注入口。
 *
 * 流水线的各阶段都想说话（"配音 3 段 12.4s"、"素材匹配 → xxx"、"帧 900/16137"），
 * 但库不该决定这些字去哪。CLI 把它接到 stderr（stdout 留给结果，BR-U6-2），
 * 测试传 `silent` 或收集到数组里断言。
 */

/** 一行进度诊断. */
export type Log = (message: string) => void;

/** 丢弃所有进度输出（库的默认行为）. */
export const silent: Log = () => {};

/** 写到 stderr —— CLI 与 demo 脚本用这个. */
export const toStderr: Log = (message) => {
  process.stderr.write(`${message}\n`);
};
