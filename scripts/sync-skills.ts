/**
 * `bun run skills:sync` —— 把仓库里的 skills 拷到 `~/.kiro/skills/`。
 *
 * 仓库的 `skills/` 是**唯一事实源**，用户目录那份是运行时副本。两边手工同步过一段时间，
 * 结果是两份内容漂移：用户目录的版本写着仓库里已经删掉的参数，而 agent 读的是用户目录
 * 那份。同步做成一条命令之后，"改哪一份"就不再是个需要记住的约定。
 *
 * 只覆盖本仓库拥有的 skill 目录（`skills/*`），不动 `~/.kiro/skills/` 下别的技能。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = new URL("../skills/", import.meta.url).pathname;
const DEST = join(homedir(), ".kiro", "skills");

const names = readdirSync(SRC).filter((n) =>
  statSync(join(SRC, n)).isDirectory(),
);
if (names.length === 0) {
  console.error("skills/ 下没有任何 skill 目录，什么都没同步");
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
for (const name of names) {
  const from = join(SRC, name);
  const to = join(DEST, name);
  cpSync(from, to, { recursive: true });
  console.log(`${existsSync(to) ? "✅" : "❌"} ${name} → ${to}`);
}
console.log(`\n同步 ${names.length} 个 skill（仓库 skills/ 是事实源）`);
