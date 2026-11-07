# 第三方组件与许可声明

本项目自身代码以 **MIT** 许可发布（见 [LICENSE](./LICENSE)）。
`vendor/` 目录内置的描摹 / 渲染引擎由第三方提供，各自保留原许可，不随本项目改为 MIT。

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@visioncortex/vtracer` | 1.0.0-alpha.4 | **MIT OR Apache-2.0** | VTracer 彩色描摹（WASM） |
| `esm-potrace-wasm`（Potrace） | 0.5.1 | **GPL-2.0** | 黑白 / 海报化描摹（WASM） |
| `@resvg/resvg-wasm` | 2.6.2 | **MPL-2.0** | SVG → PNG 渲染（WASM） |
| `svgo` | 4.1.0 | **MIT** | SVG 优化压缩 |
| `imagetracerjs` | 1.2.6 | **Unlicense** | ImageTracer 描摹（实验引擎） |
| `paper`（Paper.js） | 0.12.18 | **MIT** | 同色路径布尔并集 |

## 分发注意

- **GPL-2.0 的 Potrace** 与 MIT 主项目并存：对外分发包含 Potrace 的构建产物时，
  需按 GPL-2.0 履行相应义务（提供源代码、保留许可声明等）。
  若用于商业闭源分发，请先单独评估该组件的许可兼容性。
- **MPL-2.0 的 resvg** 为文件级 copyleft：修改其源文件时需公开该文件的修改版；
  未修改的二进制分发不受影响。
- 各组件完整许可文本可从其 npm 包或上游仓库获取；本文件仅作清单与提示，不构成法律意见。
