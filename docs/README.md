# VectorKit 文档索引

> 本目录集中存放 VectorKit 的设计规范、专项方案、技术实现与变更记录。
> 项目入口与快速开始见仓库根目录的 [`../README.md`](../README.md)。

## 📐 设计与规范

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [DESIGN.md](./DESIGN.md) | 界面视觉规范（Claymorphism 粘土型态）——**UI 唯一事实来源**，改动界面先读此文件 | 生效中 |

## 🗺️ 规划与专项方案

> ⚠️ **动手前先读 [`PLAN_REVIEW_2026-10-13.md`](./PLAN_REVIEW_2026-10-13.md)** ——
> 它是**计划状态总表与下一步唯一待办清单**，并记录了 9 处已被证伪/失效的前提。
> 其余计划文档均以它为准。

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [PLAN_REVIEW_2026-10-13.md](./PLAN_REVIEW_2026-10-13.md) | ★ **计划审查报告**：9 处站不住脚的前提、指标体系（观感指标一等公民）、**计划状态总表**、下一步清单、8 条纪律 | **单一事实来源** |
| [PLAN_HIGH_FIDELITY.md](./PLAN_HIGH_FIDELITY.md) | 高清矢量化专项计划（v2）：平滑边缘 + 色块整合的迭代主线与执行进度 | 执行中 |
| [PLAN_PARALLEL_ENGINE.md](./PLAN_PARALLEL_ENGINE.md) | 并列引擎计划：按 VectorCraft 机制做亚像素边界（含止损标准）。**未接入生产链路** | 进行中（P0/P1/去碎片化已完成） |
| [PLAN_JOINT_OPTIMIZATION.md](./PLAN_JOINT_OPTIMIZATION.md) | C 方案计划：联合优化 / 可微光栅化 | **已废弃** —— 被 `PLAN_PARALLEL_ENGINE` 取代，仅历史留存 |
| [SMOOTHING_PLAN.md](./SMOOTHING_PLAN.md) | 矢量输出平滑方案（v2.2 提案）：细节保留 + 减少锯齿 | 已并入主线 |
| [OPTIMIZATION_EDGE_SEPARATION.md](./OPTIMIZATION_EDGE_SEPARATION.md) | 平滑边缘 & 色块隔离：多引擎源码拆解 + vectorkit 结合优化方案 | **已完成**，结论已并入 CHANGELOG |
| [QUALITY_VS_TIME.md](./QUALITY_VS_TIME.md) | 为什么转得快？「加时间」有用吗 —— 耗时/质量实测与档位设计 | 已实测 |
| [COMPARISON_DESKTOP_VS_WEB.md](./COMPARISON_DESKTOP_VS_WEB.md) | 对照文档：Vector Magic 桌面版（软件） vs vectorkit（Web 应用） | 持续更新 |
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
- **推进迭代** → 在 `PLAN_HIGH_FIDELITY.md` 的「执行进度」中留痕，避免上下文丢失；
  同时更新 `PLAN_REVIEW_2026-10-13.md` 第四节的状态总表（**两处必须一致**）。
- **下结论** → 客观指标（PSNR/白缝）**不得单独支撑**结论，须附至少一个观感代理指标。
- 版本号规则：按**累计版本数**编号 —— 首版 `v0.1`，此后每版 `+0.1`，逢 10 进一
  （第 10 版 = `v1.0`，第 43 版 = `v4.3`）；**不出现三段式版本号**。
  一致性（`package.json` ↔ CHANGELOG 最新条目 ↔ 无三位版本号）由 `npm test` 自动断言。
