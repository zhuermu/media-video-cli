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
