# media-video-agent

半自动短视频生产管线：把一篇 Markdown 文章（或一句主题）变成一条**竖版口播视频** +
一个**可直接上传的发布包**（视频号 / 抖音）。

单人自媒体工具，本地 macOS 运行，无云端部署。所有确定性工作（校验、合成、渲染、
打包、登记）由 `vagent` CLI 完成；内容创作（script.json、发布文案）由 LLM agent
或人来写。

## 两种成片形态

| 形态                 | 入口                                                                | 画面                                         | 渲染耗时      |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------- |
| **静态卡片**（默认） | `vagent init` → 六步流水线                                          | 大字要点卡片，可带背景照片 + 暗遮罩          | 分钟级        |
| **白板手绘动画**     | 同上，script 加 `style`；或 `vagent whiteboard render <article.md>` | 一支笔按真笔顺写字、描图表、拉图片，段间运镜 | 整片约 1 小时 |

## 快速开始

### 依赖

- [Bun](https://bun.sh) ≥ 1.3（运行时 + 包管理 + 测试）
- FFmpeg / ffprobe：`brew install ffmpeg`
- TTS：默认 Edge TTS（免费、联网，`msedge-tts`）；离线可切 macOS `say`

```bash
git clone git@github.com:zhuermu/media-video-agent.git
cd media-video-agent
bun install
cp .env.example .env      # 全部键可留空，见「配置」
bun run vagent help
```

第三方素材二进制（手势贴图、插画、音效、手写字体）不入库，需要时按
[docs/assets-setup.md](docs/assets-setup.md) 重新拉取。缺素材不会报错，
渲染会自动降级（无手势 / 纯文字版式 / 纯口播）。

### 标准流水线（静态卡片）

```bash
vagent init my-video --article ./article.md   # 或 --topic "一句主题"
# → 写 videos/my-video/script/script.json（LLM 或手写）
vagent script validate my-video               # ⏸ 停点 1：人工审 script.md
vagent tts run my-video
vagent compose run my-video
vagent package assemble my-video              # ⏸ 停点 2：人工审 SUMMARY.md 后手动上传
vagent register add --platform douyin --url … --title … --published-at … --package …
```

`vagent` = `bun run src/cli/main.ts`，命令须在仓库目录下执行。

### 白板讲解视频（文章直出）

```bash
vagent whiteboard render ./article.md --only-stills   # 几秒出关键帧，先复核版式
vagent whiteboard render ./article.md                 # 整片，约 1 小时
```

改过文章或版式后必须加 `--fresh`（默认续跑会复用旧帧）。
文章写法与场景 DSL 见 [docs/whiteboard.md](docs/whiteboard.md)。

## 硬红线

这些约束在代码里有强制点，不是建议：

1. **绝不自动发布**。没有浏览器自动化，没有上传脚本。管线终点是「输出发布包 +
   上传检查单」，上传永远是人工动作。
2. **绝不生产受限领域内容**：金融投资、医疗健康、法律、赌博。两道防线——LLM 自检
   （软）+ `assets/domain-guard.json` 词表在 CLI 内硬拦（`DomainGuardError`，
   退出码 4，零产物落盘）。
3. **绝不缺 AIGC 声明**。发布包必须含 `aigc-declaration.md`，上传检查单第一项
   就是提醒勾选平台的 AI 内容标记。
4. **绝不吞错**。CLI 非零退出必须原样转达给用户（错误类型 + 消息）后停止；唯一
   例外是 script.json 修复循环，最多 2 次。
5. **素材逐条可追溯授权**。入库素材必须在 manifest 里写全 source + license。

内容限定通用领域：技术/编程/AI、效率工具、职业成长。

## 配置

`.env`（自研解析，无 dotenv 依赖）。合并时**不覆盖**已存在的环境变量。全部可选：

| 键              | 默认值                                        | 说明                           |
| --------------- | --------------------------------------------- | ------------------------------ |
| `TTS_BACKEND`   | `edge`                                        | `edge` \| `say`                |
| `TTS_VOICE`     | 随后端（`zh-CN-XiaoxiaoNeural` / `Tingting`） | 音色                           |
| `CARD_TEMPLATE` | `default`                                     | `assets/templates/<name>.json` |
| `VIDEOS_ROOT`   | `./videos`                                    | 每条视频的工作目录根           |
| `DATA_ROOT`     | `./data`                                      | 发布登记 / 指标数据面          |
| `FFMPEG_PATH`   | `ffmpeg`                                      | 显式路径或 PATH 名，启动时探活 |

凭据只放 gitignore 的 `.env` 或 macOS Keychain；所有日志/错误输出经
`redact()` 掩码。**任何真实密钥都不得进入代码、配置、文档、fixture 或 git 历史。**

## 文档

| 文档                                                       | 内容                                       |
| ---------------------------------------------------------- | ------------------------------------------ |
| [docs/cli.md](docs/cli.md)                                 | 命令逐条参考、退出码表、`--json` 信封      |
| [docs/architecture.md](docs/architecture.md)               | 分层规则、模块地图、错误模型、契约         |
| [docs/whiteboard.md](docs/whiteboard.md)                   | 白板风格：场景 DSL + 文章直出管线          |
| [docs/assets-setup.md](docs/assets-setup.md)               | 克隆后如何恢复被 gitignore 的素材二进制    |
| [docs/development.md](docs/development.md)                 | 开发工作流、质量门禁、当前已知缺口         |
| [assets/ASSETS.md](assets/ASSETS.md)                       | 素材库来源、授权、性能陷阱（原始勘查笔记） |
| [skills/video-agent/SKILL.md](skills/video-agent/SKILL.md) | LLM agent 编排层（零业务逻辑）             |

## 目录结构

```
src/
  core/        纯逻辑，不调 process.exit，抛类型化错误
    config/    .env 加载、默认值、redact()、ffmpeg 探活
    errors/    类型化错误层级 + 退出码表
    workdir/   每条视频的工作目录管理
    script/    script.json 校验 / 时长估算 / 审核物 / 领域词表拦截
    cards/     卡片版式、SVG、栅格化、帧表
    tts/       合成编排 + backends/（edge、say）
    render/    视频渲染（ffmpeg 后端）
    pkg/       发布包组装 / 契约校验 / 检查单
    registry/  发布登记、周指标、报表（JSONL）
    whiteboard/       白板场景 DSL：笔顺手写、图标笔描、运镜、音效规划
    whiteboard-video/ 文章直出白板视频：分镜、配音、排片、逐帧、混音
  adapters/
    ffmpeg/    argv 构造、probe、run、混音（子进程胶水层）
  cli/
    main.ts    唯一的 process.exit 调用点
    parse.ts   路由表 + 参数
    commands/  一命令一文件
skills/video-agent/   SKILL.md 编排层（删掉它 CLI 仍完全可用）
assets/               domain-guard 词表、卡片模板、素材清单 + 抓取脚本
experiments/          一次性技术验证脚本（非生产代码，见其 README）
videos/<slug>/        每条视频工作目录（gitignore）
```

架构规则、边界约定与"新东西该放哪"见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
bun run check     # 门禁：prettier --check + bun test（含覆盖率阈值）
bun test          # 单测 + e2e
bun run format    # prettier --write
```

`bun run check` 目前**退出码非零**：测试 311 全通过，卡在覆盖率阈值——新增的
`src/core/whiteboard-video/` 模块尚未补齐测试。详见
[docs/development.md](docs/development.md#已知缺口)。

## 许可

尚未声明。仓库内 `assets/` 下的第三方素材各有自己的授权条款，见
[assets/ASSETS.md](assets/ASSETS.md)；其中 Sparkol 手势库与 ManyPixels 插画的
二进制**不随仓库分发**。
