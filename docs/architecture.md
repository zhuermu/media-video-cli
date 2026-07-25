# 架构

## 分层

```
cli/        唯一的边界层：捕获错误 → 映射退出码 → process.exit
  ↓
core/       纯逻辑：可单测、抛类型化错误、从不退出进程
  ↓
adapters/   子进程与外部系统胶水（不计入覆盖率分母）
```

三条硬规则：

1. **`core` 从不调 `process.exit`。** 它只抛 `AppError` 子类。`src/cli/main.ts`
   是全项目唯一的 `process.exit` 调用点。
2. **FFmpeg 调用只出现在 `src/adapters/ffmpeg/`。** 渲染后端通过统一适配接口接入；
   未来的剪映/CapCut 路径作为 `src/adapters/` 下的兄弟目录加入，**不织进管线步骤**。
3. **管线各步通过文件契约交换数据**，不是内存耦合。步骤间的界面是发布包契约与
   `videos/<slug>/` 下的显式文件。

每个 `core` 模块通过 `index.ts` 暴露 API；测试同目录并置（`*.test.ts`）。

## 模块地图

### core

| 模块                | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| `config/`           | `.env` 加载（自研解析）、默认值表、`redact()`、ffmpeg 探活     |
| `errors/`           | 类型化错误层级 + 锁定的退出码表                                |
| `workdir/`          | 每条视频的六目录布局、状态机、原子写                           |
| `script/`           | `script.json` 校验、时长估算、审核物渲染、领域词表拦截         |
| `cards/`            | 卡片版式（断行/避头/分页）、SVG 构造、栅格化、帧表             |
| `tts/`              | 合成编排（幂等、退避重试、实测时长）+ `backends/`（edge、say） |
| `render/`           | `RenderJob` 端口 + ffmpeg 后端 + 产物 probe 自检               |
| `pkg/`              | 发布包组装、Manifest v1 三层契约校验、上传检查单               |
| `registry/`         | 发布登记、周指标、周报/基线报告（JSONL 数据面）                |
| `whiteboard/`       | 白板**场景 DSL**：笔顺手写、图标笔描、图表、运镜、音效事件规划 |
| `whiteboard-video/` | **文章直出**白板视频：分镜、多角色配音、排片、逐帧、混音、字幕 |

`whiteboard/` 与 `whiteboard-video/` 是两条不同入口：前者服务 `compose run` 的
`style: "whiteboard"`（script.json 声明场景），后者服务 `whiteboard render`
（Markdown 文章直出）。见 [whiteboard.md](whiteboard.md)。

### adapters

`ffmpeg/` — `args.ts`（纯 argv 构造）、`probe.ts`、`mix.ts`（音效混音图）、
`run.ts`（真正 spawn）。`run*.ts` 与 `core/tts/backends/**` 不计入覆盖率分母：
它们是薄胶水，不是可单测逻辑。

### cli

```
main.ts        解析 → 分派 → 单一 catch → exit（唯一 exit 点）
parse.ts       ROUTES 路由表 + util.parseArgs（零 CLI 框架依赖）
envelope.ts    JsonEnvelope ok/err
exit.ts        错误 → 退出码映射
commands/      一命令一文件
```

## 错误模型

全部继承 `AppError`，自带 `exitCode`。**禁止裸 `throw new Error(...)`。**
退出码表见 [cli.md](cli.md#退出码)（锁定，改动需协调）。

Fail-fast 纪律：

- 子进程失败必须携带 **argv + 捕获的 stderr**
- TTS 失败必须携带 **backend + 段序号**
- 永不静默吞错。静默降级是最难查的一类问题——一张图找不到会让搬入手势和点指
  一起消失，成片看起来「就是这么设计的」。

## 纯度与幂等

- **纯函数优先**：argv 构造、版式计算、SVG 生成同输入必须逐字符相等。快照测试
  以此为锚。
- **幂等跳过**：TTS 段、卡片帧、白板帧已存在即复用。要强制重渲就删目录
  （`whiteboard render` 用 `--fresh`）。
- **原子写**：状态文件走 `.tmp` → rename，不留半成品。
- **确定性**：同一份输入两次跑必须出同一条视频，否则没法判断「画面变了」是改
  对了还是素材/模型漂了。素材匹配同分时按 slug 字典序取首个即为此。

## 新东西该放哪

| 要加什么    | 放哪                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| 新 CLI 命令 | `src/cli/commands/<name>.ts` + `parse.ts` 路由 + `main.ts` 分派 case      |
| 新 TTS 后端 | `src/core/tts/backends/`（在 `registry.ts` 注册）                         |
| 新渲染后端  | `src/adapters/` 下新建兄弟目录，**不改管线步骤**                          |
| 新错误类型  | `src/core/errors/index.ts`（继承 `AppError`，认领退出码——表锁定，先协调） |
| 新卡片模板  | `assets/templates/<name>.json`（`CARD_TEMPLATE` 指名）                    |
| 新素材库    | `assets/<库名>/`（必须带 manifest/index 记录 source + license）           |

## 编排层边界

`skills/video-agent/SKILL.md` 是给 LLM agent 的编排说明，**零业务逻辑**：删掉
整个 `skills/` 目录，CLI 必须仍然完全可用。agent 负责生成内容（script.json、
发布文案），所有确定性工作委派给 CLI。

## 与其他技能的耦合

素材通过**显式文件路径**交接，绝不跨技能代码 import。
