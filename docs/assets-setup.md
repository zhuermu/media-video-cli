# 素材恢复

仓库只跟踪素材的**清单/索引 + 抓取脚本**，不跟踪二进制。原因有两个：

1. **体积** — 全量素材约 100MB+（2362 张插画 SVG、484 张手势 PNG、字体、音效），
   而它们全部可按脚本重新拉取。
2. **授权** — 部分素材的再分发条款不清楚。尤其 Sparkol 手势库是 VideoScribe 的
   授权库内容，本地原型使用没问题，**放进公开仓库分发是一个需要核实的授权问题，
   不是工程问题**。详见 [../assets/ASSETS.md](../assets/ASSETS.md)。

**缺素材不会让渲染失败**，只会降级（无手势 / 纯文字版式 / 楷体轮廓代替手写体 /
纯口播）。所以下面这些都是按需执行，不是安装步骤。

## 恢复清单

| 素材             | 恢复命令                                                 | 授权                             |
| ---------------- | -------------------------------------------------------- | -------------------------------- |
| 手写字体         | 见下（LXGW WenKai）                                      | SIL OFL 1.1                      |
| ManyPixels 插画  | `python3 assets/manypixels/fetch_manypixels.py download` | 免费商用，需署名                 |
| Sparkol 手势     | `python3 assets/sparkol/fetch_library.py full <group>`   | Sparkol 库条款，**再分发需核实** |
| Sparkol 背景音乐 | `python3 assets/sparkol/fetch_library.py music 10`       | 同上                             |
| 音效             | 按 `assets/sfx/manifest.json` 逐条从 Mixkit 下载         | Mixkit SFX Free License          |

抓取脚本都是**可续跑**的：已存在且非空的文件跳过。

### 手写字体

`assets/fonts/manifest.json` 记录了来源与许可证。默认条目：

```
LXGW WenKai（霞鹜文楷）— SIL Open Font License 1.1
https://github.com/lxgw/LxgwWenKai
```

把 `.ttf` 放进 `assets/fonts/` 即可。白板渲染取该目录**字典序第一个**可解析的
`.ttf`/`.otf`；缺字体时自动回退楷体笔画轮廓。

### ManyPixels 插画

```bash
python3 assets/manypixels/fetch_manypixels.py index      # 重建 index.json（已入库，通常不需要）
python3 assets/manypixels/fetch_manypixels.py download   # 拉全部 SVG，可续跑
```

`index.json`（已入库）带全部 2362 条的 slug/标题/分类/画风/关键词，所以**素材库
离线可检索**——匹配逻辑只需要索引，不需要 SVG 文件在位。

五种画风各约 473 张，落在 `assets/manypixels/svg/<style>/`。同一条视频必须锁一种
画风，默认 `Azureline`。

### Sparkol 手势

```bash
python3 assets/sparkol/fetch_library.py index            # 索引 + 全部 333 张缩略图
python3 assets/sparkol/fetch_library.py full suneeta      # 拉指定分组的全分辨率
python3 assets/sparkol/fetch_library.py full pens
```

可用分组：`pens`（纯笔，不遮挡画面）、`Seasonal`（72 个万圣节道具，含板擦）、
以及 13 套人手 —— `hannah` `billy` `suneeta` `jacob` `jonny` `hiswill` `matt`
`mike` `daniel` `joe` `sibin` `yasmin` `rosie`（覆盖不同肤色、成人/儿童手、左右手）。

每只手三个文件：`<slug>-draw.png`（笔触板）、`<slug>-move.png`（笔抬起，用于
笔画间移动）、`<slug>-thumb.png`（160px 预览）。尽管 CDN 返回 `.jpg` /
`application/octet-stream`，实际都是透明 RGBA PNG。

拉下来后建议压到 800px 上限（151 个文件 67.4MB → 31.4MB，alpha 保留）：

```bash
python3 assets/shrink_rasters.py --dry-run
python3 assets/shrink_rasters.py --max-height 1000
```

### 音效

`assets/sfx/manifest.json` 已登记 9 条 Mixkit 音效（含引擎挂钩的 `writing` 与
`whoosh`），逐条带 `source` + `license`。按其中的链接下载对应文件放回该目录即可。

要自己配库就复制 `manifest.example.json` 为 `manifest.json`——**每条必须填全
`source` 和 `license`**，缺任一项会被直接拒绝加载（硬红线：素材逐条可追溯授权）。

### Pexels 照片（可选，未入库）

`experiments/whiteboard-poc/assets/pexels/fetch_pexels.py` 已就绪但默认拉不到东西：
API 无 key 返回 401，而爬 pexels.com 违反其服务条款。

```bash
export PEXELS_API_KEY=...     # 免费 key: https://www.pexels.com/api/
python3 fetch_pexels.py search "whiteboard" "office meeting" --per 30
```

免费额度 200 请求/小时。Pexels License 允许商用免署名，但每次下载仍会把摄影师
和来源 URL 记进 `_index.json` 旁挂文件。注意这是位图照片，**不能被笔描画**，
只能做背景或插图。

## 署名义务

CC BY 4.0 素材集与 ManyPixels 插画在成片中使用时需要可见署名。Tabler（MIT）、
Heroicons（MIT）、Lucide（ISC）不需要。

发布包的 `materials-manifest.md` 就是这份追溯记录的落点——`compose run` 会把本次
实际用到的音效与手写字体条目自动追加进去。
