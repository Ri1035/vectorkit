# VectorKit

> 纯前端矢量转换器：位图 ⇄ 矢量、SVG 优化压缩、CMYK EPS 导出，全部在浏览器本地完成，不上传服务器。

## 项目简介

VectorKit 是一个完全在浏览器本地运行的矢量图形转换工具，文件解析、描摹、压缩均不产生任何网络请求。内置 VTracer / Potrace 双描摹引擎，支持位图转矢量、矢量转位图、SVG 优化压缩与去背景，并可导出面向印刷的 CMYK EPS；优化输出对 CorelDRAW X4 等老软件做了兼容处理。

## 主要功能

- 位图 → 矢量：PNG / JPG / WebP / GIF / BMP 输入，VTracer 彩色描摹 + Potrace 黑白 / 海报化双引擎，参数可微调
- 图像预处理与矢量后处理：降采样、去噪、保边平滑、颜色量化；碎块清理、边缘平滑、同色路径合并
- 参数模板：6 套一键套用配置（高保真 / 极小文件 / 线稿印章等）
- CMYK EPS 导出：印刷四色 EPS，支持透明底
- 矢量 → 位图：SVG 转 PNG / WebP / JPEG，1×–4× 倍率可调
- SVG 优化压缩：移除元数据、坐标精度压缩、可选 SVGZ
- 纯色背景一键去除

## 快速开始

```bash
npm install
npm run dev
```

然后打开 http://127.0.0.1:5188（需通过 HTTP 访问，直接双击 `index.html` 的 file:// 方式无法加载 wasm）。

## 技术栈

- 原生 JavaScript（ESM）· VTracer / Potrace / resvg（WASM）· SVGO · Paper.js
- 纯静态站点，可部署到 Cloudflare Pages / Netlify / Vercel 等任意静态托管

## 部署 / 演示地址

- 线上地址：https://vectorkit.pages.dev
- 代码仓库：https://github.com/Ri1035/vectorkit

## 修改记录

> 说明：修改记录仅记录文档维护变更，不计入版本更新。

| 日期 | 修改内容 |
| --- | --- |
| 2026-10-05 | README 精简为项目介绍，补充 topics 标签 |
