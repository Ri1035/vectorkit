# VectorKit

> 纯前端矢量转换器：位图 ⇄ 矢量、SVG 优化压缩、CMYK EPS 导出，全部在浏览器本地完成，不上传服务器。

![JavaScript](https://img.shields.io/badge/-JavaScript-f7df1e?logo=javascript&logoColor=black)
![SVG](https://img.shields.io/badge/-SVG-ffb13b?logo=svg&logoColor=white)
![WebAssembly](https://img.shields.io/badge/-WebAssembly-654ff0?logo=webassembly&logoColor=white)
![Cloudflare Pages](https://img.shields.io/badge/Cloudflare%20Pages-在线体验-F38020?logo=cloudflare&logoColor=white)

## ✨ 项目简介

VectorKit 是一个完全在浏览器本地运行的矢量图形转换工具，文件解析、描摹、压缩均不产生任何网络请求。内置 VTracer / Potrace 双描摹引擎，支持位图转矢量、矢量转位图、SVG 优化压缩与去背景，并可导出面向印刷的 CMYK EPS；优化输出对 CorelDRAW X4 等老软件做了兼容处理。

## 🚀 特性亮点

| 维度 | 说明 |
| --- | --- |
| 位图 → 矢量 | PNG / JPG / WebP / GIF / BMP 输入，VTracer 彩色描摹 + Potrace 黑白 / 海报化双引擎，参数可微调 |
| 图像预处理 / 矢量后处理 | 降采样、去噪、保边平滑、颜色量化；碎块清理、边缘平滑、同色路径合并 |
| 参数模板 | 6 套一键套用配置（高保真 / 极小文件 / 线稿印章等） |
| CMYK EPS 导出 | 印刷四色 EPS，支持透明底 |
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
| [docs/PLAN_HIGH_FIDELITY.md](./docs/PLAN_HIGH_FIDELITY.md) | 高清矢量化专项计划与执行进度 |
| [docs/OPEN_SOURCE_METHODS.md](./docs/OPEN_SOURCE_METHODS.md) | 自研矢量化方案集（6 项算法） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 完整版本变更历史 |

## 修改记录

> 说明：修改记录仅记录文档维护变更，不计入版本更新。

| 日期 | 修改内容 |
| --- | --- |
| 2026-10-08 | 仓库整理：文档下沉至 `docs/`、构建脚本归位至 `scripts/`，新增文档索引 |
| 2026-10-05 | README 精简为项目介绍，补充 topics 标签 |
| 2026-10-05 | README 美化丰富：补充在线体验与参考来源，完善使用说明 |
