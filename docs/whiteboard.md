# 白板手绘动画

一支笔在白板上按真笔顺写字、描线稿图标、描图表、拉入图片，段间运镜，收尾
zoom-out 全览。技术栈：Bun + resvg 逐帧纯函数 SVG + FFmpeg。

有**两条独立入口**，用途不同：

| 入口                     | 输入                         | 谁定画面                   | 适合           |
| ------------------------ | ---------------------------- | -------------------------- | -------------- |
| `compose run`（`style`） | `script.json` + 每段 `scene` | LLM/人显式声明场景元素     | 精确控版的短片 |
| `whiteboard render`      | 一篇 Markdown 文章           | 由 Markdown 结构确定性映射 | 文章直出讲解片 |

---

## 入口一：script.json 场景 DSL

在 `script.json` 根级加 `"style": "whiteboard"`（可选
`"theme": "clean" | "ocean" | "forest"`），且**每段必须带 `scene`**：

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

| type      | 字段                                             | 表现                                      |
| --------- | ------------------------------------------------ | ----------------------------------------- |
| `title`   | `text`（≤12 字）, `underline?`                   | 大字手写 + 可选强调下划线                 |
| `text`    | `text`（≤18 字）                                 | 正文手写行                                |
| `bullet`  | `text`（≤18 字）                                 | 对勾 + 手写要点行                         |
| `icon`    | `name`, `accent?`, `label?`（≤10 字）            | 线稿图标笔描                              |
| `chart`   | `chart: "bars-up"\|"line-up"\|"steps"`, `label?` | 图表笔描 + 填色淡入                       |
| `image`   | `src`(.jpg/.jpeg/.png), `circle?`, `label?`      | 照片拉入（路径同 `backgroundImage` 约定） |
| `sticker` | `name`                                           | 色块装饰件（淡入，不占版式）              |

`icon` 可用名：`arrow-right` `arrow-swoosh` `circle` `check` `cross` `star`
`burst` `wave` `lightbulb` `box` `speech-bubble` `cloud` `magnifier` `heart`
`target` `rocket` `trophy` `thumbs-up` `crown` `fire` `sparkles` `flag` `pin`

`sticker` 可用名：`blob` `tape` `star-badge` `confetti` `highlight`

未知的 `icon`/`sticker` 名、超长文案、坏 `chart` 种类会在 `script validate`
阶段**一次报全**并列出可用清单。

**写作建议**：每段 2-3 个元素为宜（口播 15-25 秒才撑得起 4 个以上）；开场段用
`title`；图表/图标段配 `label`；全片至多 1-2 个 `sticker` 点缀。

`image.src` 的相对路径解析到 `videos/<slug>/input/images/`，绝对路径原样使用；
文件不存在直接 `NotFoundError`，不静默跳过。

### 帧与幂等

白板帧输出在 `videos/<slug>/cards/whiteboard/`，已存在的帧跳过。改脚本后要强制
重渲，删掉该目录再跑 `compose run`。

音画同步以 **TTS 实测段时长**为准：`Σ 帧显示时长` 精确等于 `Σ 实测段时长`。

---

## 入口二：Markdown 文章直出

```bash
vagent whiteboard render ./article.md --only-stills   # 先复核版式（几秒）
vagent whiteboard render ./article.md                 # 整片（约 1 小时）
vagent whiteboard render ./article.md --fresh         # 改过文章后必须加
```

管线：

```
article.md
  → parseArticle()        分镜 + cast（谁说话）+ format 指令
  → speakSection()        Edge TTS 逐句合成（可多人）+ 词级时间戳 + 落盘缓存
  → resolveFormat()       按实测总时长定体裁：<3min 竖版短片 / ≥3min 横版长教程
  → composeStoryboard()   匹配素材 → 白板版式 → 时间轴（写/搬/擦/指 + 整板擦净）
  → renderFrames()        resvg 逐帧
  → buildNarrationTrack() 逐句 adelay 入轨 → mixSfx() 叠 writing/whoosh
  → muxVideo()            ffmpeg → mp4（+ 旁挂 SRT）
```

体裁按**实测配音总时长**判而非字数估算：同样字数，播报腔和快语速能差出小一半
时长，跨过 3 分钟这条线就会选错版式（竖版短片与横版长教程不是等比缩放关系）。

### 文章写法（也是 LLM 的输出约定）

| Markdown                      | 含义                                   |
| ----------------------------- | -------------------------------------- |
| `# 标题`                      | 全片主标题                             |
| `> cast: …`                   | 片级指令：角色 → 音色                  |
| `> format: auto\|short\|long` | 片级指令：强制体裁                     |
| `## 标题`                     | 一个分镜，标题写在板上                 |
| 普通段落                      | 口播台词（**只有它进配音**，板上不写） |
| `角色：台词`                  | 指定说话人（角色须在 `cast` 里）       |
| `角色（情绪）：台词`          | 指定说话人 + 情绪                      |
| `- 列表项`                    | 板上的打勾要点（写）                   |
| `~~文本~~`                    | 先写、再擦掉的假设（擦）               |
| `![alt](路径)`                | 搬进画面的外部图片（搬）               |
| `![alt](il:kw1,kw2)`          | 素材库英文检索词，匹配一张扁平插画     |

```
> cast: 主讲=news-male-formal, 提问=narrator-female-warm
> cast: interview          # 也可以直接写预设名
> format: auto
```

情绪词：`平静`/`沉稳`→calm，`上扬`/`轻快`→upbeat，`严肃`/`警告`→serious,
`温和`/`安慰`→gentle，`急`/`紧迫`→urgent，`设问`/`疑问`→question。

两条容易翻车的约定：

- **口播与板书故意分离。** 板上是关键词，口播是完整句子。让两者相同是最常见的
  翻车方式——观众会去读板上的长句，然后既没听清也没看完。
- **插画检索词用英文。** 素材库关键词是英文，中英映射属于上游 LLM 的活（它在读
  全文，比事后猜关键词准）。库里 2362 条，同片锁一种画风（默认 `Azureline`），
  五种画风线宽配色体系不同，混用会像拼贴。

### 素材依赖与降级

| 缺什么                     | 表现                                                   |
| -------------------------- | ------------------------------------------------------ |
| 手写字体                   | 回退楷体笔画轮廓                                       |
| `assets/sparkol/`          | 无手势贴图（笔迹仍在）                                 |
| `assets/manypixels/`       | 退化为纯文字版式                                       |
| `assets/sfx/manifest.json` | 纯口播，不报错                                         |
| 文章引用的外部图片         | **报警到 stderr**（搬入 + 点指手势会缺失），不静默跳过 |

恢复素材见 [assets-setup.md](assets-setup.md)。

### 性能陷阱：不要给 resvg 传 `resourcesDir`

按相对路径引用手势 PNG 需要 resvg 的 `resourcesDir`，而这个选项让每帧慢一个
数量级（1080×1920 单帧实测 75ms → 608ms，开盘写更是 1396ms）。一段 20s 竖版
片子会从 45s 变成 6 分钟以上。

`hand.ts` 改为把手势贴图 inline 成 base64 data URI，并在加载时一次性降采样到
屏幕尺寸——inline 原始 800×1250 会让每帧 SVG 涨到 MB 级，逼 resvg 每秒重解码
30 次大图。切换后实测 62ms/帧（竖版）、75ms/帧（横版）。

### 笔尖位置来自像素，不是元数据

Sparkol 元数据的 `drawOffset`/`moveOffset` **不落在笔尖上**（实测偏移
20-60px，`suneeta-black-marker` 声明的 `(57,-16)` 甚至在图外，真实笔尖在
`(43,114)`）。`hand.ts` 从 alpha 通道量笔尖，只用元数据判断**笔指向哪个角**
（库里有左手套装）。元数据贡献它对的那部分（朝向），像素贡献精度。

注意 `pens/` 分组带投影，投影会碰到图角——同一套量法不能用在它上面。

---

## 音效

`assets/sfx/manifest.json` 里 `id` 为 `writing` / `whoosh` 的条目是引擎挂钩：
`writing` 循环铺在笔书写区间，`whoosh` 打在每次运镜起点。没有该文件则纯口播，
不报错。

**入库的每条音效必须可追溯授权**（硬红线）：`source`（库名 + 条目链接）+
`license` 缺一不可，缺了直接拒绝加载。BGM 不入库——发布时在平台官方曲库人工配。
