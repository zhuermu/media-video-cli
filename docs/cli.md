# CLI 参考

`vagent` = `bun run src/cli/main.ts`（package.json script）。在仓库目录下运行。

```bash
bun run vagent <命令> [参数]
bun run vagent help          # 命令表 + 停点提示
```

## 契约

- **stdout = 结果，stderr = 进度/诊断。** 管道取结果时只需要 stdout。
- `--json` 时 stdout 只输出单行 `JsonEnvelope`：`{ok, step?, data?, error?}`，
  stderr 仍是进度诊断。
- `src/cli/main.ts` 是全项目**唯一**的 `process.exit` 调用点；core 模块只抛
  类型化错误，从不退出进程。

## 全局参数

| 参数            | 说明                                                    |
| --------------- | ------------------------------------------------------- |
| `--json`        | stdout 只输出 `JsonEnvelope`                            |
| `--videos-root` | 覆盖视频工作目录根（默认 `$VIDEOS_ROOT` 或 `./videos`） |

## 标准流水线

### `vagent init <slug> --article <path.md> | --topic <文字>`

初始化 `videos/<slug>/` 六目录布局，保存输入素材。

- slug 格式非法、输入文件不存在 → 拒绝且不留残渣
- 目录已存在 → 拒绝，**不自动改名**

### `vagent script validate <slug>`

校验 `videos/<slug>/script/script.json`，生成人工审核物 `script/script.md`。

- 违规**一次报全**（一行一条），不是报第一条就停
- 领域词表命中 → `DomainGuardError`（退出码 4），零产物落盘
- ⏸ **停点 1**：审 `script.md`，确认后再 `tts run`

### `vagent tts run <slug> [--backend edge|say] [--voice <音色>]`

逐段语音合成 → 归一化 → 合并音轨，并记录**实测**每段时长（后续帧时长分配依赖它，
不用字数估算）。

- 幂等：已存在的段不重新合成
- 网络类错误退避重试 500/1000ms，共 3 次；非网络错误立即抛出
- 失败错误携带 backend + 段序号

### `vagent compose run <slug>`

渲染画面帧并合成 9:16 视频。前置：script + tts 已完成。

- `script.json` 无 `style` → 静态卡片路径（模板取自 `CARD_TEMPLATE`）
- `style: "whiteboard"` → 白板路径（场景 DSL 逐帧渲染 + 可选音效混音）
- 幂等跳过已有帧；改脚本后要强制重渲，删掉 `cards/` 下对应目录再跑
- 产物 probe 自检（分辨率/时长/流数）不符 → 删除半成品 + 报错

### `vagent package assemble <slug> [--cover <图片>]`

组装发布包并校验契约。缺件、frontmatter 不合法等问题在**一条**报错里逐条列出。

- 未指定封面 → 回退第一张卡片 PNG；指定封面宽度 < 720px → 拒绝
- 组装中途失败不留半成品
- ⏸ **停点 2**：审 `package/SUMMARY.md` 检查单 → 人工上传 → `register add`

### `vagent package validate <slug>`

对已组装的发布包跑 Manifest v1 契约校验（机器门禁）。三层独立校验，不短路。
不通过 → `ContractViolationError`（退出码 9）。

## 数据面

### `vagent register add`

```
--platform <shipinhao|douyin> --url <链接> --title <标题>
--published-at <ISO时间> --package <发布包目录>
```

登记一次人工发布。幂等键 `platform + url`；同 url 不同平台可各记一条。

### `vagent metrics add`

```
--platform <shipinhao|douyin> --week <ISO周一>
--followers <n> --views <n> --likes <n> --comments <n> --shares <n>
```

录入一条周指标。`--week` 必须是 ISO 周一。重复键视为**更正追加**，读取时取最新。

### `vagent report weekly [--json]`

周报表。互动率为锁定公式；`views = 0` 时数据里为 `null`、显示为「无数据」。

### `vagent report baseline [--json]`

基线报告。每平台需 ≥ 4 个不同周的数据，否则 `InsufficientDataError`（退出码 10）。

## 白板讲解视频

### `vagent whiteboard render <article.md> [参数]`

一篇 Markdown → 一条白板视频（配音 + 手写板书 + 手势 + 字幕）。
体裁默认按**实测配音总时长**判定：< 3min 竖版短片，≥ 3min 横版长教程。

| 参数                       | 说明                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `--kind short\|long\|auto` | 强制体裁（默认 `auto`）                                     |
| `--only-stills`            | 只出关键帧，几秒出结果，用于目视复核版式                    |
| `--fresh`                  | 从零重渲（默认续跑，复用已有帧）                            |
| `--no-burn`                | 不把字幕烧进帧（SRT 始终旁挂输出）                          |
| `--persona <名>`           | 手势 persona（`assets/sparkol/<persona>/`，默认 `suneeta`） |
| `--arm cuff\|extend`       | 手臂收尾方式：袖口切断 / 接出画面                           |
| `--assets <素材根>`        | 素材根目录（其下按约定找 `sparkol/`、`manypixels/`）        |
| `--out <目录>`             | 产物目录（默认文章同级 `out/`）                             |
| `--frames <目录>`          | 帧序列目录（默认 `frames-<文章名>/`）                       |
| `--stills <目录>`          | 关键帧目录（默认 `stills/`）                                |
| `--cache <目录>`           | TTS 落盘缓存（默认 `cache/tts/`）                           |
| `--tag <前缀>`             | 产物文件名前缀（默认文章名）                                |

⏸ 整片渲染约 1 小时。先 `--only-stills` 复核，再渲整片；**改过文章或版式必须加
`--fresh`**，否则会复用旧帧出一条对不上的片子。

默认路径全部从**文章名**派生而非固定常量：两条视频并行渲染时固定帧目录会互相
`rm -rf`（实测丢过 3804 帧且日志显示「成功」）。

## 门禁

### `vagent check`

串行跑 `prettier --check` + `bun test` 并汇总（不短路，任一失败即整体失败）。
等价于 `bun run check`。

## 退出码

**锁定表**，改动需先协调（`src/core/errors/index.ts` 的 `EXIT_CODES`）：

| 码  | 含义                                            |
| --- | ----------------------------------------------- |
| 0   | 成功                                            |
| 1   | 未捕获异常                                      |
| 2   | `ValidationError` — 参数/schema/不变式违规      |
| 3   | `NotFoundError` — 文件、目录、可执行程序缺失    |
| 4   | `DomainGuardError` — 受限领域词表命中（零产物） |
| 5   | `IoError` — 读写失败、状态文件损坏              |
| 6   | `FfmpegError` — 携带 argv + stderr              |
| 7   | TTS 类错误（网络 / 限流 / 输出畸形 / 后端）     |
| 8   | `RenderError` — 栅格化 / 帧渲染失败             |
| 9   | `ContractViolationError` — 发布包契约不达标     |
| 10  | `InsufficientDataError` — 数据量不足以出报告    |

所有具体错误类都继承 `AppError` 并自带 `exitCode`；禁止裸 `throw new Error(...)`。
