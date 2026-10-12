# VectorKit 文档索引

> 本目录集中存放 VectorKit 的设计规范、专项方案、技术实现与变更记录。
> 项目入口与快速开始见仓库根目录的 [`../README.md`](../README.md)。

## 📐 设计与规范

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [DESIGN.md](./DESIGN.md) | 界面视觉规范（Claymorphism 粘土型态）——**UI 唯一事实来源**，改动界面先读此文件 | 生效中 |

## 🗺️ 规划与专项方案

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [PLAN_HIGH_FIDELITY.md](./PLAN_HIGH_FIDELITY.md) | 高清矢量化专项计划（v2）：平滑边缘 + 色块整合的迭代主线与执行进度 | 执行中 |
| [SMOOTHING_PLAN.md](./SMOOTHING_PLAN.md) | 矢量输出平滑方案（v2.2 提案）：细节保留 + 减少锯齿 | 已并入主线 |
| [OPTIMIZATION_EDGE_SEPARATION.md](./OPTIMIZATION_EDGE_SEPARATION.md) | 平滑边缘 & 色块隔离：多引擎源码拆解 + vectorkit 结合优化方案 | 待实施 |
| [QUALITY_VS_TIME.md](./QUALITY_VS_TIME.md) | 为什么转得快？「加时间」有用吗 —— 耗时/质量实测与档位设计 | 已实测 |
| [OPTIMIZATION_PLAN.md](./OPTIMIZATION_PLAN.md) | 竞品拆解（Vector Magic 桌面版）后的优化计划与结论 | 参考 |

## 🔬 技术实现

| 文档 | 说明 |
| --- | --- |
| [OPEN_SOURCE_METHODS.md](./OPEN_SOURCE_METHODS.md) | 自研矢量化方案集：后处理管线中的 6 项自研算法（可独立复用） |

## 📜 变更记录

| 文档 | 说明 |
| --- | --- |
| [CHANGELOG.md](./CHANGELOG.md) | 完整版本变更历史（含每次迭代的问题、方案与结论） |

## 文档维护约定

- **改界面** → 先读 `DESIGN.md`，改完同步更新。
- **改算法 / 加方案** → 更新 `OPEN_SOURCE_METHODS.md`，并在 `CHANGELOG.md` 记录版本。
- **推进迭代** → 在 `PLAN_HIGH_FIDELITY.md` 的「执行进度」中留痕，避免上下文丢失。
- 版本号规则：按**累计版本数**编号 —— 首版 `v0.1`，此后每版 `+0.1`，逢 10 进一
  （第 10 版 = `v1.0`，第 43 版 = `v4.3`）；不出现三段式版本号。
