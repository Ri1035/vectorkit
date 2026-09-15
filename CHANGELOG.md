# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/) 与 [约定式提交](https://www.conventionalcommits.org/zh-hans/)。

## [0.2.0] - 2026-09-15

界面全面重做与出图质量升级，已部署上线。

### 新增

- **全新界面**：统一设计令牌（配色 / 间距 / 圆角 / 阴影层级），组件样式全面收敛
- **深色模式**：跟随系统 `prefers-color-scheme` 自动切换全套配色
- **三档响应式**：移动端（<640px，底部标签栏）、平板（640–1080px，单栏）、桌面（>1080px，双栏）；触摸目标不小于 44px
- **favicon 全套**：由用户提供的品牌 SVG 生成 `favicon.svg` / `favicon.ico` / 16–512px PNG / `apple-touch-icon.png`，深浅双色两套，SVG 版自动适配深浅色系统
- **resvg 渲染引擎**（`@resvg/resvg-wasm`）：SVG→位图改用 resvg，输出跨设备一致的高精度抗锯齿；PNG 可直接由 resvg 字节直出，避免 canvas 重采样损失
- **超采样导出**：2×/4× 渲染后降采样，提升小尺寸边缘质量（带 1600 万像素上限保护，防止大图×大倍率叠加导致内存溢出）
- **SVGO 优化**（`svgo/browser`）：位图转矢量的输出与独立优化页均接入 SVGO（multipass + 精度控制），实测可减小 30–70% 体积；原自研轻量优化器保留为回退路径
- 渲染引擎可切换（resvg / 浏览器原生），resvg 失败时自动回退

### 性能

- 引擎懒加载：首屏不加载任何 wasm，首次实际使用时才下载对应引擎
- 转换结果缓存：参数与输入未变化时直接复用上次结果
- `canvas.toBlob` / `createImageBitmap` 在无头与部分环境不回调，统一改为带超时回退的同步路径

### 变更

- 移除 Web Worker 方案：实测 module worker 内的模块加载（静态与动态 import）在本环境会永久挂起，改为更可靠的主线程懒加载

### 验证

无头 Edge 端到端回归全部通过：四引擎线上初始化成功；位图转矢量（VTracer+SVGO，15.7KB/7 路径/216 节点）；矢量转位图（resvg，2568×2980/164KB）；优化压缩（SVGO+SVGZ）；桌面视口无横向溢出。

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
