# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [约定式提交](https://www.conventionalcommits.org/zh-hans/)。

## [0.1.0] - 2026-09-15

首个可用版本，纯前端实现，已部署上线。

### 新增

- **位图 → 矢量**
  - 双引擎：VTracer（官方 WASM，彩色描摹）+ Potrace（黑白描摹 / 彩色海报化）
  - 5 套 VTracer 预设（Logo 图标 / 照片 / 线稿签名 / 海报扁平 / 像素画）
  - 4 套 Potrace 预设（锐利线条 / 圆润曲线 / 强去噪 / 海报分层）
  - 主参数滑杆 + 高级参数（分区算法、层级模式、曲线模式、颜色精度、路径精度、曲线简化容差）
  - 内置示例图，无需自备素材即可试用
  - 原图 / 结果并排对比，输出体积、路径数、路径节点、耗时统计
- **矢量 → 位图**
  - SVG → PNG / WebP / JPEG
  - 1×–4× 倍率、透明 / 白 / 黑 / 自定义背景、质量可调
- **优化 / 压缩**
  - 移除元数据、注释、空容器与多余属性
  - 坐标精度压缩（0–6 位小数）
  - SVGZ（gzip）输出，显示节省比例

### 技术实现

- 引擎接入：`build-vtracer.mjs` 把 `@visioncortex/vtracer` 的 wasm-bindgen
  `nodejs` target 转换为浏览器可用的 ESM 封装（原包用 `require('fs').readFileSync()`
  读 wasm，浏览器无法直接运行）
- 无构建步骤的纯静态产物；`build.mjs` 仅做文件收集输出到 `dist/`
- 全部处理在浏览器本地完成，零后端、零上传

### 部署

- GitHub：https://github.com/Ri1035/vectorkit（私有）
- Cloudflare Pages：https://vectorkit.pages.dev
  - 项目名 `vectorkit`，生产分支 `main`

### 质量验证

在无头 Edge 环境完成端到端验证：

| 项目 | 结果 |
|---|---|
| VTracer 彩色描摹 | MAE 1.1–1.5，480×480 约 54 ms |
| Potrace 黑白描摹 | 输出 1.7 KB / 3 条路径 |
| Potrace 彩色海报化 | MAE 3.7–5.6 |
| 线上引擎加载 | VTracer + Potrace 均初始化成功 |

### 已知限制

- 不支持 AI / EPS / PS 等 PostScript 系格式
- 不支持 CDR / CDT / CMX / XAR / SK1 等专有二进制格式
- 不支持旧版 VSD
- 单文件建议控制在 1600 px 以内（内部会等比缩放）
- Potrace 引擎许可为 GPL-2.0，商业闭源产品需单独评估
