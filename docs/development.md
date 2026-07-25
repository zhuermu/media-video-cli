# 开发

## 命令

```bash
bun run vagent <cmd>   # = bun run src/cli/main.ts
bun test               # 单测 + e2e（含覆盖率）
bun run check          # 门禁：prettier --check + bun test
bun run format         # prettier --write .
```

全部在仓库目录下执行。

## 质量门禁

`bun run check` 必须通过才能合入 `main`、才能打 tag。

**直接读退出码，不要把测试/门禁命令接管道**（`| tail` 之类会吞掉真实退出码——
本仓库排查覆盖率失败时就踩过这个坑）。

覆盖率阈值 80%（行），分母**只算纯逻辑**：薄子进程胶水通过 `bunfig.toml` 的
`coveragePathIgnorePatterns` 排除：

```
src/adapters/**/run*.ts
src/core/tts/backends/**
```

## 约定

- **Prettier 默认配置**，由门禁强制。
- 命名：变量/函数 camelCase，类/类型 PascalCase，**文件名 kebab-case**。
- 文件顶部写 `@module` 文档注释，并指明该模块遵守的边界规则（BR-*）。
- 依赖**精确锁版本**，禁止 `^`/`~` 浮动范围；提交 `bun.lock`。
- 非官方生态库（如剪映/CapCut 草稿工具）只能通过 adapter 层调用，并采用锁版本 +
  手动升级纪律。
- 测试与实现同目录并置（`*.test.ts`）；e2e 用提交在库里的极小 fixture（<100KB），
  几秒内跑完，不依赖本地媒体文件。

## 发布前检查

```bash
gitleaks detect --source . --log-opts="--all"    # 全历史
bun audit
```

## 已知缺口

以下问题**已知未修**，记录在此以免被当成新发现：

### `bun run check` 退出码非零

测试 311 全通过（0 fail），门禁卡在**覆盖率阈值**。低覆盖集中在新增的
`src/core/whiteboard-video/` 模块：

| 文件              | 行覆盖 | 性质                   |
| ----------------- | ------ | ---------------------- |
| `flat-import.ts`  | 2.5%   | SVG 导入，IO 胶水偏多  |
| `narrate.ts`      | 9.4%   | TTS 调用胶水           |
| `gestures.ts`     | 21.4%  | **纯逻辑**，确实缺测试 |
| `hand.ts`         | 30.6%  | **纯逻辑**，确实缺测试 |
| `images.ts`       | 29.6%  | 文件 IO 胶水           |
| `assets-match.ts` | 32.7%  | 纯逻辑，部分缺测试     |
| `render.ts`       | 42.5%  | 帧写盘 + ffmpeg 胶水   |
| `compose.ts`      | 64.9%  | 纯逻辑，部分缺测试     |
| `blocks.ts`       | 57.3%  | 纯逻辑，部分缺测试     |
| `board.ts`        | 76.4%  | 接近阈值               |

**不能靠扩 `coveragePathIgnorePatterns` 把门禁刷绿**：其中 `gestures.ts`、
`hand.ts`、`compose.ts`、`blocks.ts` 是实打实的纯 SVG 生成逻辑，属于分母内，
缺的是测试而不是排除规则。

`whiteboard-video` 来自一个**尚在进行中**的工作流（白板动画能力，AI-DLC 工作流
仍处在 ideation 阶段），其 build-and-test 阶段还没跑。补测试是那条线的活。

### `whiteboard-video` 的错误类型未收敛

`article.ts` 里还有裸 `throw new Error(...)`（文章缺 `##` 分镜时），违反
「禁止裸 Error」的约定，应改为 `ValidationError`。同模块其他位置也需要过一遍
类型化错误。

### `experiments/` 是冻结的一次性验证

`experiments/` 下的脚本是白板能力的技术验证，已被 `src/core/whiteboard*/`
产品化取代。它们引用的批量素材目录不入库，直接跑会缺素材。保留是为了记录探索
过程，不是可运行示例。见 `experiments/README.md`。
