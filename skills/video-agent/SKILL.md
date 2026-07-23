---
name: video-agent
description: 半自动短视频制作技能。当用户说「做条视频」「文章转视频」「主题做视频」，或想把一篇 Markdown 文章 / 一个主题制作成竖版口播卡片视频并准备发布包时使用。编排 vagent CLI 全流程（init → script → tts → compose → package → register），含两处人工审核停点；绝不自动发布。
---

# video-agent — 文章/主题 → 竖版口播卡片视频（半自动流水线）

你是流程编排者，不是业务执行者：所有确定性工作（校验、合成、渲染、打包、登记）都委托给
vagent CLI；你只做**参数收集、生成 LLM 文案（script.json 与 metadata 五件）、转述进度与
错误、在两个审核位呈现产物并代收用户确认**。CLI 删除本技能后仍完整可用；本技能不含任何
独立业务逻辑（BR-U6-5）。

## 运行方式

所有命令在 `media-video-agent/` 目录下运行：

```bash
bun run src/cli/main.ts <命令> [参数]     # 下文简写为 vagent <命令>
```

- stdout = 结果；stderr = 进度与诊断。需要结构化结果时加 `--json`（stdout 只输出一行
  JsonEnvelope：`{ok, step?, data?, error?: {type, message, context}}`）。
- 退出码：0 成功；2-10 为类型化错误（ValidationError=2、NotFoundError=3、
  DomainGuardError=4、IoError=5、FfmpegError=6、TTS*=7、RenderError=8、
  ContractViolationError=9、InsufficientDataError=10）；1 为未捕获异常。

## 两条铁律（先读再动）

1. **禁止自动发布**（BR-U6-7 / C13 红线）：绝不执行、生成或建议任何自动上传/自动发布/
   浏览器自动化操作。上传永远由用户人工完成；本技能到「呈现发布包 + 提醒检查单」为止。
2. **错误转述、不绕过**（BR-U6-6）：任何 CLI 非零退出，必须把 `error.type`、`message`
   与其中的建议动作**原样转述**给用户后停下。禁止吞错、静默重试掩盖、或用别的方式绕过
   校验（唯一例外：步骤 3 的 script.json 修正循环，上限 2 次，见下）。

## 编排流程

### 步骤 0 · 参数收集

- 素材二选一：**文章路径**（`.md` 文件）或**主题**（一句话文字）。
- slug：如用户未给，从标题/主题 kebab 化建议一个（小写字母数字与连字符，2-64 字符，
  如「bun 上手指南」→ `bun-shang-shou-zhi-nan` 或语义化英文 `bun-quickstart`），
  向用户确认后使用。

### 步骤 1 · 领域自审（软防线）

生成任何内容前，自查主题是否属于**严管域：财经投资、医疗健康、法律、博彩**。疑似命中
即向用户说明「该主题属于平台严管领域，本流水线不制作此类内容」并**终止流程**。
这是软防线；CLI 内 U3 词表（`assets/domain-guard.json`）是硬防线，命中会以
DomainGuardError（退出码 4）拒绝且零产物落盘（BR-U6-12：两道防线都必须在，自审不能
替代词表）。

### 步骤 2 · 初始化工作目录

```bash
vagent init <slug> --article <path.md>    # 或 --topic "<主题文字>"
```

### 步骤 3 · 生成 script.json 并校验

按下表约束生成 `videos/<slug>/script/script.json`（写入后运行校验）：

| 字段                   | 约束                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `title`                | 非空字符串，≤60 字符                                                      |
| `topic`                | 非空字符串，≤500 字符（超长会被截断并警告，不拒绝）                       |
| `segments`             | 数组，**3-20 段**                                                         |
| `segments[].text`      | 口播文字，非空，≤300 字符/段（TTS 输入）                                  |
| `segments[].cardText`  | 卡片要点文案，非空，≤80 字符（≠口播全文，是提炼）                         |
| `segments[].emphasis?` | 可选高亮词数组；**每项必须是该段 cardText 的子串**                        |
| `source`               | `{ "kind": "article"\|"topic", "ref": "<素材路径或主题原文>" }`，ref 非空 |

写作要求：总时长目标 60-180s（约 4.5 字/秒估算，即全文口播 270-810 字为宜）；cardText
是屏幕大字要点，短句、可扫读；emphasis 从 cardText 里挑 1-2 个原样子串。

```bash
vagent script validate <slug>
```

- **校验失败**（ValidationError，退出码 2）：从 stderr（或 `--json` 的
  `error.message`）读取逐条 violations 清单，**一次性修正全部问题**后重写 script.json
  再校验。修正循环 **≤2 次**（BR-U6-8）；仍失败则把完整 violations 清单呈现给用户，
  请用户裁决，不得继续自行重试。
- **DomainGuardError**（退出码 4）：转述命中的类别与词条，终止流程（不要改写措辞
  规避词表——那是绕过校验，违反铁律 2）。

### 步骤 4 · 审核位 1：脚本人工审核 ⏸

校验通过后**呈现 `videos/<slug>/script/script.md` 全文**（含逐段文案与时长估算），
向用户收集裁决：

- 「**继续**」→ 进入步骤 5。
- 「**修改**」（附意见）→ 按意见改 script.json，回步骤 3 重新校验（修改后的重新校验
  不计入 ≤2 次修正循环——那个上限只管 LLM 对 violations 的自动修正）。

未获用户明确「继续」不得进入下一步。

### 步骤 5 · 语音合成与视频合成

```bash
vagent tts run <slug>          # 可选 --backend edge|say --voice <音色>
vagent compose run <slug>
```

两条命令运行期间把 stderr 的关键进度摘要转述给用户（如「正在合成第 N 段」「正在渲染
卡片帧」）。任一非零退出 → 按铁律 2 转述后停。

### 步骤 6 · 生成 metadata 五件

在 `videos/<slug>/input/metadata/` 下生成 **5 个文件**（package assemble 的前置契约，
缺一或 frontmatter 不合规都会被一次性清单拒绝）：

| 文件                    | 要求                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `metadata-shipinhao.md` | 视频号文案；**必须带 frontmatter**（规范见下）                                                                     |
| `metadata-douyin.md`    | 抖音文案；**必须带 frontmatter**（规范见下）                                                                       |
| `aigc-declaration.md`   | AIGC 声明；**以 `templates/aigc-declaration.md` 为兜底模板**，必须保留「上传时勾选平台 AI 生成内容声明选项」的提醒 |
| `materials-manifest.md` | 素材清单；用 markdown 列表（`- ` 行）逐条列出素材来源与授权（组装时会自动追加 TTS/模板/FFmpeg 条目）               |
| `publish-advice.md`     | 发布建议（发布时间、封面/标题选择建议等），非空即可                                                                |

两个平台文案文件的 frontmatter 规范（成对 `---` 分隔，缺失或未闭合=校验失败）：

```markdown
---
titles:
  - 候选标题一
  - 候选标题二
  - 候选标题三
tags: [标签1, 标签2]
description: 一句话简介（非空）
---

正文文案……
```

- `titles`：**恰好 3 条**候选标题（多不裁少不补，直接判违规）。
- `tags`：**至少 1 条**。
- `description`：**非空**字符串。

### 步骤 7 · 组装发布包 + 审核位 2 ⏸

```bash
vagent package assemble <slug>    # 可选 --cover <图片>（宽度须 ≥720px）
```

（组装内部已含契约校验；如需单独重验可用 `vagent package validate <slug>`。）

成功后**呈现 `videos/<slug>/package/SUMMARY.md` 检查单全文**，并特别提醒：

> ⚠️ 上传时**必须勾选平台的「AI 生成内容」声明选项**——这是检查单置顶必选项。

然后请用户**人工核对检查单、人工上传**。此处流程暂停，等用户回来。

### 步骤 8 · 发布登记（用户确认上传完成后）

用户告知已上传后，**代填参数并征求确认**：

```bash
vagent register add --platform <shipinhao|douyin> --url <用户提供的链接> \
  --title <实际采用的标题> --published-at <ISO时间> \
  --package videos/<slug>/package
```

用户确认后执行。随后提醒：每周可用 `vagent metrics add ...` 录入指标，满 4 周后
`vagent report baseline` 可出基线报告。

## 异常呈现规范（全流程适用）

- 非零退出 → 转述「错误类型 + message（含建议动作）」，`--json` 模式下再附
  `error.context` 里对用户有用的字段（如 violations 清单、失败段索引）。
- 永远不要替用户「想办法绕过去」：不改校验、不删产物重跑掩盖、不跳过停点。
- 同一问题两次修复尝试后仍失败 → 完整呈现给用户并等待指示。
