# VectorKit

> 纯前端矢量转换器：位图 ⇄ 矢量、SVG 优化压缩、CMYK EPS 导出，全部在浏览器本地完成，不上传服务器。

![JavaScript](https://img.shields.io/badge/-JavaScript-f7df1e?logo=javascript&logoColor=black)
![SVG](https://img.shields.io/badge/-SVG-ffb13b?logo=svg&logoColor=white)
![WebAssembly](https://img.shields.io/badge/-WebAssembly-654ff0?logo=webassembly&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare%20Pages-在线体验-F38020?logo=cloudflare&logoColor=white)

## ✨ 项目简介

VectorKit 是一个完全在浏览器本地运行的矢量图形转换工具，文件解析、描摹、压缩均不产生任何网络请求。内置 **VTracer / Potrace / ImageTracer 三描摹引擎**，支持位图转矢量、矢量转位图、SVG 优化压缩与去背景；可导出面向印刷的 CMYK EPS 与面向切割的 DXF；提供「描摹分辨率」等质量档位与边缘/色块后处理，优化输出对 CorelDRAW X4 等老软件做了兼容处理。

## 🚀 特性亮点

| 维度 | 说明 |
| --- | --- |
| 位图 → 矢量 | PNG / JPG / WebP / GIF / BMP 输入，VTracer 彩色描摹 + Potrace 黑白 / 海报化 + ImageTracer 高细节对照，参数可微调 |
| 图像预处理 / 矢量后处理 | 降采样、去噪、保边平滑、颜色量化；碎块清理、边缘平滑、同色路径合并 |
| 参数模板 | VTracer 6 套（Logo / 照片 / 线稿 / 海报扁平 / 像素画 / vmde 最高保真）+ Potrace 3 套 + ImageTracer 4 套，一键套用 |
| CMYK EPS 导出 | 印刷四色 EPS，支持透明底 |
| DXF 导出 | AutoCAD R12 POLYLINE，面向切割 / CNC 流程 |
| 质量档位 | 「描摹分辨率」关闭 / 自动 / ×2 / ×3（含 8M 像素安全预算） |
| 重栅格化精修 | 实验：按与原图的像素误差做局部坐标下降（默认关闭，fail-safe 回滚） |
| 矢量 → 位图 | SVG 转 PNG / WebP / JPEG，1×–4× 倍率可调 |
| SVG 优化压缩 | 移除元数据、坐标精度压缩、可选 SVGZ |
| 一键去背景 | 纯色背景一键去除 |

## 📖 快速开始

```bash
npm install
npm run dev
```

然后打开 http://127.0.0.1:5188 即可使用。适用场景：把位图 logo / 线稿描摹成可印刷矢量，或把 SVG 优化压缩后导入 CorelDRAW X4 等老版本软件的桌面生产流程。

## 🌐 在线体验

| 入口 | 地址 |
| --- | --- |
| 在线体验 | https://vectorkit.pages.dev |
| 源码仓库 | https://github.com/Ri1035/vectorkit |

## 🧰 技术栈

- 原生 JavaScript（ESM）· VTracer / Potrace / resvg（WASM）· SVGO · Paper.js
- 纯静态站点，可部署到 Cloudflare Pages / Netlify / Vercel 等任意静态托管

## ❓ 常见问题

- **双击 `index.html` 打开后功能报错？** 工具依赖 WASM，必须通过 HTTP 访问（如 `npm run dev` 后的 http://127.0.0.1:5188），直接用 `file://` 方式无法加载 wasm。

## 🙏 参考与致谢

- VTracer（`@visioncortex/vtracer`）—— 位图转矢量彩色描摹引擎（本地内置）
- Potrace（`esm-potrace-wasm`）—— 位图转矢量黑白 / 海报化描摹引擎（本地内置）
- SVGO（`svgo`）—— SVG 优化压缩（本地内置）
- resvg / Paper.js —— SVG 渲染与矢量处理

> 各引擎参数与渲染管线的详细实现见源码，本文不做展开。

## 📚 文档

设计规范、专项方案、技术实现与变更历史统一收录于 [`docs/`](./docs/README.md)：

| 文档 | 内容 |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | 界面视觉规范（UI 唯一事实来源） |
| [docs/PLAN_REVIEW_2026-10-13.md](./docs/PLAN_REVIEW_2026-10-13.md) | ★ **计划审查报告**：指标体系、计划状态总表、后续唯一待办清单 |
| [docs/NEGATIVE_RESULTS.md](./docs/NEGATIVE_RESULTS.md) | ★ **负面结果清单**：已证伪/不要重复的路径与重测条件 |
| [docs/PLAN_HANDOVER_2026-11-07.md](./docs/PLAN_HANDOVER_2026-11-07.md) | 交接实验落地计划：几何后处理证伪结论、阶段与进度 |
| [docs/PLAN_HIGH_FIDELITY.md](./docs/PLAN_HIGH_FIDELITY.md) | 高清矢量化专项计划与执行进度 |
| [docs/PLAN_PARALLEL_ENGINE.md](./docs/PLAN_PARALLEL_ENGINE.md) | 并列引擎（VectorCraft 机制）实施计划，**未接入生产** |
| [docs/OPEN_SOURCE_METHODS.md](./docs/OPEN_SOURCE_METHODS.md) | 自研矢量化方案集（6 项算法） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 完整版本变更历史 |

## 修改记录

> 说明：本表记录仓库与文档维护变更；产品功能变更计入 [CHANGELOG](./docs/CHANGELOG.md)。

| 日期 | 修改内容 |
| --- | --- |
| 2026-11-07 | v7.8：描摹分辨率 ×2/×3/×4 复测（×2 无害、×3 仅低分辨率线稿有效、扁平图 ×3/×4 降质） |
| 2026-11-07 | v7.7：修复 `ssimEdge` 混窗导致的指标越界（新增 9 项断言 + 2 项源码守护） |
| 2026-11-07 | v7.6：阶段 2 四图复测完成，`polygon` 重拟合否决、cutout 撕边量化、`ssimEdge` 退化值登记 |
| 2026-11-07 | v7.5：接收交接实验（几何后处理证伪），新增 `NEGATIVE_RESULTS.md` 与 `PLAN_HANDOVER_2026-11-07.md`，归档交接书 |
| 2026-11-07 | 安全清理（移除 2 个外传凭据的 workflow）＋ 测试脚本补回 ＋ 依赖/构建/许可/文档状态收口（v7.4） |
| 2026-10-13 | 文档索引补全（新增计划审查报告、并列引擎计划）；引擎表述与实际一致（补 ImageTracer） |
| 2026-10-08 | 仓库整理：文档下沉至 `docs/`、构建脚本归位至 `scripts/`，新增文档索引 |
| 2026-10-05 | README 精简为项目介绍，补充 topics 标签 |
| 2026-10-05 | README 美化丰富：补充在线体验与参考来源，完善使用说明 |

**实验能力**：默认引擎为 VTracer；另提供 Potrace（黑白）与 ImageTracer（实验，保真更高但节点/体积极大）。
重栅格化精修、对比度感知降噪均为**默认关闭**的实验项。

## 孤儿分支索引

以下分支与本仓库 `main` **无共同祖先**（unrelated histories），项目文件位于分支根目录，历史按原样保留。完整记录见 [MERGE-REPORT.md](MERGE-REPORT.md)。

| 分支 | 来源仓库 | 技术栈 | 状态与验证 |
|---|---|---|---|
| `orphan/Vector-DB` | Vector-DB | 纯静态 HTML/JS（位图转矢量工具） | **冻结存档分支**：内容冻结于合并日（2026-11-04），除用户主动要求外不再维护/更新；验证通过（入口静态 200） |

> `orphan/Vector-DB` 仅作历史存档，不随 `main` 演进；需要最新能力请使用 `main`。

```bash
git fetch origin && git checkout orphan/Vector-DB
```
