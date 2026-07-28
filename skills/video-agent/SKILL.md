---
name: video-agent
description: 半自动短视频制作技能。当用户说「做条视频」「文章转视频」「主题做视频」，或想把一篇 Markdown / Html 文章 / 一个主题制作成竖版口播卡片视频并准备发布包时使用。编排 vagent CLI 全流程（init → script → tts → compose → package → register），含两处人工审核停点；绝不自动发布。
---

# video-agent — 文章/主题 → 竖版口播卡片视频（半自动流水线）

你是流程编排者，不是业务执行者：所有确定性工作（校验、合成、渲染、打包、登记）都委托给
vagent CLI；你只做**参数收集、生成 LLM 文案（script.json 与 metadata 五件）、转述进度与
错误、在两个审核位呈现产物并代收用户确认**。CLI 删除本技能后仍完整可用；本技能不含任何
独立业务逻辑（BR-U6-5）。

## 运行方式：先读 schema，再试跑，最后真跑

所有命令在 `media-video-cli/` 目录下运行：

```bash
bun run src/cli/main.ts <命令> [参数]     # 下文简写为 vagent <命令>
```

**① 参数从 schema 拿，不要从本文抄。**

```bash
vagent schema --json    # 整张命令表：每条命令的参数类型/值域/默认值/示例/产物/前置
```

本文只讲**流程与内容约束**；参数细节以 schema 为准。理由很直接：抄一份参数说明进
skill，命令改了之后这份就是错的，而错的表现是你传了一个不存在的 flag。

**② 贵命令先试跑。** 任何命令都支持 `--dry-run`：校验参数与前置产物、打印将写哪些
文件与规模预估（段数、帧数、预计耗时），**零写入**后退出 0。

```bash
vagent tts run <slug> --dry-run --json      # 先看段数与预计时长
vagent compose run <slug> --dry-run         # 先看缺不缺前置产物
```

TTS 是联网合成、compose/whiteboard 是几分钟到一小时的渲染。试跑一秒钟能查出的问题
（slug 拼错、script.json 还没写、五份 metadata 缺一份），不要用一次真跑去发现。

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

## 人设注入（写任何文案之前）

```bash
vagent persona show --json
```

拿到的是作者人设：`tone`（口吻规则）、`topics`（选题范围）、`avoid`（不碰的题材）、
`keepEnglish`（术语英文保留清单）、`cta`（关注引导候选）、`penName` / `signature`
（署名）、`defaultVoice`（默认音色）。**所有 LLM 产出的文案都按它写**：script.json 的
口播、两个平台的 titles/description、publish-advice。

不要把这些规则抄进本文——人设改了本文不会跟着改，而"同一个号出现两种口吻"是观众唯一
会记住的不一致。人设文件缺失时 `persona show` 会明说未配置，此时按中性技术口吻写，
并且不署名、不写 CTA。

## 术语：term of art 保留英文

`keepEnglish` 清单里的词**一律保留英文原词**，首次出现可以加一句中文注解，但不要用译名
替换它：

> prompt · context · harness · loop · graph · agent · verifier · fan-out · fan-in ·
> state · topology · routing · embedding · token · RAG · MCP · skill ·
> context window · state machine · guardrail

两个理由：这些词是社区共识的检索锚点，译过来读者就搜不到原文；而且「上下文工程」
「图工程」这类译法在不同文章里指的还不是同一件事——译名会把一个精确的词变成一个含糊的词。

**口播里也保留。** TTS 念英文术语没有问题，念一个自造译名才会让同行皱眉。

## 改写海外英文原文的协议

拿英文原文（博客、论文、release note）改写成中文视频稿时，逐条遵守：

1. **术语不译**（见上）。原文的 `loop engineering` 就写 loop engineering。
2. **观点不能升级成事实。** 原文「某人认为 / 有人主张」必须保留归属；写成「事实是」
   是最常见也最致命的一类失真。
3. **数字、版本号、时间点回原文核对。** 记不准就不写，别取整、别推测。
4. **保留出处与作者。** materials-manifest.md 里逐条写原文标题 + 链接 + 作者；
   转述观点时在口播里点名是谁说的。
5. **不搬运，要重构。** 视频稿的结构按"观众的问题顺序"重排，不是把原文段落顺序翻译一遍。

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

#### 白板手绘动画风格（可选，`style: "whiteboard"`）

知识类视频的主打形态：一支笔在白板上按真笔顺写字、描图表、拉入图片，段间运镜，
收尾 zoom-out 全览。启用方式：script.json 根级加 `"style": "whiteboard"`（可选
`"theme": "clean"|"ocean"|"forest"`），且**每段**必须带 `scene`：

```json
{
  "style": "whiteboard",
  "theme": "clean",
  "segments": [
    {
      "text": "口播文字……",
      "cardText": "要点",
      "scene": {
        "elements": [
          { "type": "title", "text": "开场标题", "underline": true },
          { "type": "text", "text": "补充一句" }
        ]
      }
    }
  ]
}
```

场景元素表（每段 1-6 个元素，竖排自动版式，语义声明零坐标）：

| type      | 字段                                             | 约束                                    |
| --------- | ------------------------------------------------ | --------------------------------------- |
| `title`   | `text`（≤12 字）, `underline?`                   | 大字手写 + 可选强调下划线               |
| `text`    | `text`（≤18 字）                                 | 正文手写行                              |
| `bullet`  | `text`（≤18 字）                                 | 对勾 + 手写要点行                       |
| `icon`    | `name`, `accent?`, `label?`（≤10 字）            | 线稿图标笔描（可用名见下）              |
| `chart`   | `chart: "bars-up"\|"line-up"\|"steps"`, `label?` | 图表笔描 + 填色淡入                     |
| `image`   | `src`(.jpg/.jpeg/.png), `circle?`, `label?`      | 照片拉入（路径同 backgroundImage 约定） |
| `sticker` | `name`（可用名见下）                             | 色块装饰件（淡入，不占版式）            |

icon 可用名：`arrow-right` `arrow-swoosh` `circle` `check` `cross` `star`
`burst` `wave` `lightbulb` `box` `speech-bubble` `cloud` `magnifier` `heart`
`target` `rocket` `trophy` `thumbs-up` `crown` `fire` `sparkles` `flag` `pin`。
sticker 可用名：`blob` `tape` `star-badge` `confetti` `highlight`。

写作建议：每段 2-3 个元素为宜（口播 15-25 秒才撑得起 4 个以上）；开场段用
title，图表/图标段配 label；全片至多 1-2 个 sticker 点缀。

音效（可选）：`assets/sfx/manifest.json` 里登记了免版税音效（书写沙沙声/whoosh，
逐条 source+license）时，compose 自动在笔书写区间与运镜处低音量混入；没有该文件
则纯口播，不报错。**入库的每条音效必须可追溯授权**（C12 红线），下载来源与许可证
写全再入库。

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
vagent tts run <slug>          # 可选 --backend edge|say|minimax --voice <音色>
vagent compose run <slug>
```

两条命令运行期间把 stderr 的关键进度摘要转述给用户（如「正在合成第 N 段」「正在渲染
卡片帧」）。任一非零退出 → 按铁律 2 转述后停。

**默认用免费后端（edge）。`minimax` 是收费后端，只在用户明确要求「换成品音色」时用，
不要主动选它。** 用户提出时的正确顺序是：

```bash
vagent tts run <slug> --dry-run --json --backend minimax   # 先报要合成多少字符
vagent tts run <slug> --backend minimax --fresh            # 用户确认后再真跑
vagent compose run <slug>                                  # 音频换了，必须重合成片
```

`--fresh` 必须给：已存在的分段音频永不重合成，不清空就换后端等于一次静默空转（命令会
直接报错要求 `--fresh`）。真跑完把输出里的计费字符数转述给用户。

密钥只认一个位置：`media-video-cli/.env` 的 `MINIMAX_API_KEY=`。**不要向用户索要密钥
明文、不要把密钥写进任何命令行或文件**；缺密钥时 CLI 会以退出码 2 报出可操作提示，按
铁律 2 原样转述给用户即可。

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

**按人设写这几个字段**：标题按 `tone`（先给结论、不用「颠覆」「必看」这类词）；
`description` 结尾放一条 `cta`（关注引导，从 `persona show` 的候选里挑一条，按平台调整
长度）；`materials-manifest.md` 里逐条列原文出处（改写海外原文时尤其必要）。

发布包组装时 CLI 会把 `penName` / `bio` / `cta[0]` 写进 `manifest.json` 的 `author`
块，SUMMARY.md 的检查单也会多一项「简介或评论区首条带关注引导」——**你不需要手动往
manifest 里写署名**，只要把文案写对。

### 步骤 7 · 组装发布包 + 审核位 2 ⏸

```bash
vagent package assemble <slug>    # 可选 --cover <图片>（宽度须 ≥720px）
```

（组装内部已含契约校验；如需单独重验可用 `vagent package validate <slug>`。）

成功后**呈现 `videos/<slug>/package/SUMMARY.md` 检查单全文**，并特别提醒：

> ⚠️ 上传时**必须勾选平台的「AI 生成内容」声明选项**——这是检查单置顶必选项。

然后请用户**人工核对检查单、人工上传**。此处流程暂停，等用户回来。

呈现时把两件事一起说：AIGC 勾选（红线）与**关注引导**（`manifest.author.cta`，写在简介
结尾或评论区首条）。后者是检查单里的普通项，容易被跳过，而它是这条流水线唯一的涨粉动作。

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
