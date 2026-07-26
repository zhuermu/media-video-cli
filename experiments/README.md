# experiments — 冻结的技术验证

一次性验证脚本，**不是生产代码**，也不是可直接运行的示例。保留它们是为了记录
白板动画能力的探索过程与实测结论。

产品化后的实现在 `src/core/whiteboard/`（场景 DSL）与
`src/core/whiteboard-video/`（文章直出管线）；那两处才是维护对象。

## 内容

| 文件                                             | 验证了什么                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `whiteboard-demo/demo.ts`                        | 技术底座：resvg 逐帧纯函数 SVG + 真笔顺手写 + viewBox 运镜 + 收尾 zoom-out（627 帧 / 19s） |
| `whiteboard-poc/poc.ts`                          | 端到端串起分镜 → 配音 → 排片 → 渲帧                                                        |
| `whiteboard-poc/scribe-demo.ts`                  | 手势贴图与笔迹的配合                                                                       |
| `whiteboard-poc/gesture-demo.ts`                 | 手势四件套（写/擦/搬/指）                                                                  |
| `whiteboard-poc/tip-diag.ts`                     | 笔尖定位诊断——证明元数据 offset 不落在笔尖上，须从 alpha 通道量                            |
| `whiteboard-poc/flat-demo.ts`                    | 扁平插画拉入                                                                               |
| `whiteboard-poc/import-demo.ts`, `svg-import.ts` | 外部 SVG 导入与描画可行性                                                                  |
| `whiteboard-poc/article*.md`                     | 验证用文章                                                                                 |

## 跑不起来是预期的

这些脚本依赖的批量第三方素材（`experiments/**/assets/`、`hands/`）和渲染产物
（`frames-*/`、`stills/`、`out/`）以及 TTS 缓存（`cache/`）都不入库。要复现得先
按 [../docs/assets-setup.md](../docs/assets-setup.md) 拉素材，并对照脚本顶部的
路径常量调整。

实测结论已经沉淀进文档，通常不需要重跑：

- 性能陷阱（resvg `resourcesDir` 让每帧慢一个数量级）→ [../docs/whiteboard.md](../docs/whiteboard.md#性能陷阱不要给-resvg-传-resourcesdir)
- 笔尖定位（元数据 vs 像素）→ [../docs/whiteboard.md](../docs/whiteboard.md#笔尖位置来自像素不是元数据)
- 素材库授权与选型 → [../assets/ASSETS.md](../assets/ASSETS.md)

## 图表 / 流程图选型对比（已结论，脚本已撤）

为了决定"图表和流程图该自绘还是用现成库"，做过两次同数据三方对比。产物图保留
作为决策记录，脚本已删除——它们依赖 `echarts` 与 `@hpcc-js/wasm`，而结论是不采用
这两个库，留着死依赖不值得。

| 产物                | 对比了什么                                                                       | 结论                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chart-bakeoff.png` | A 自绘＋d3-scale / B ECharts 出 SVG 改主题＋手写标签 / C ECharts 出 PNG 搬进画面 | **A 胜**。B 的图形虽可被笔描，但外部 SVG 的 `<text>` 在 `loadSystemFonts:false` 下渲成空白，标签终究要我们手写；C 是外来物（实色、系统字体），与手写笔迹不同源 |
| `flow-bakeoff.png`  | ① 自绘写死竖直链 / ② 自绘＋dagre 布局 / ③ Graphviz 出 PNG 搬进画面               | **② 胜**。①连分支都画不出来（`命中缓存?` 只能有一条出边）；③布局正确但风格是外来物；②渲染代码不变、只把坐标交给 dagre，就拿到真实分支与汇合                    |

于是定下的分工是**只借数学层与布局层，不借渲染层**：

- 图表刻度 → `d3-scale`（`.nice()` / `.ticks()`）
- 图布局 → `@dagrejs/dagre`（只取节点坐标与边折线点）
- 画笔与文字 → 一律走自家的 `marker.ts` / `markerTextEl`

`flow-bakeoff` 还顺带查出一个影响全系统的 bug：`wobble` 的重采样步长只按总弧长
推导，路径一长就顶到 26px，把圆角（分段仅 2-3px）整片抹平——一个 78 点的胶囊形被
压成 27 点、渲成斜切六边形。修法见 `geometry.ts` 的 `resampleStep()`。
