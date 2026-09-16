# VectorKit

纯前端矢量转换器。文件的解析、转换、压缩**全部在浏览器本地完成**，不上传任何服务器，也不产生任何网络请求。

- 线上地址：https://vectorkit.pages.dev
- 代码仓库：https://github.com/Ri1035/vectorkit
- 更新日志：[CHANGELOG.md](CHANGELOG.md)

## 功能

### 1. 位图 → 矢量

- 输入：PNG / JPG / WebP / GIF / BMP
- 双引擎：VTracer（彩色描摹）+ Potrace（黑白描摹 / 彩色海报化），均可随时切换
- 5 个 VTracer 预设 + 4 个 Potrace 预设，参数可微调
- **图像预处理**：降采样、中值去噪、双边保边平滑、中值切割颜色量化——从源头减少色块数量
- **矢量后处理**：
  - 碎块清理（按面积删除孤立噪点块）
  - 边缘平滑（近直线曲线转直 + 曲线重采样简化 + 浅转角曲线化，硬边受转角阈值保护）
  - 同色路径合并（Paper.js 几何布尔并集，真正减少图形对象数，非字符串拼接）
- **参数模板**：6 个一键套用的整套配置（我的常用 / 节点精简 / 极小文件 / 高保真 / 多色照片 / 线稿印章）
- **CMYK EPS 导出**：印刷用四色 EPS，支持透明底；合并后的图形对象数即 EPS 内的填充操作数
- 输出对比预览与统计（体积 / 路径数 / 节点数 / 耗时）

### 2. 矢量 → 位图

- SVG → PNG / WebP / JPEG（resvg 渲染）
- 1×–4× 倍率，透明 / 白 / 黑 / 自定义背景
- 质量与尺寸可调

### 3. 优化 / 压缩

- 移除元数据、注释、空容器
- 坐标精度压缩
- 可选同时输出 SVGZ（gzip）
- 支持先做矢量后处理（合并 / 碎块清理 / 边缘平滑）再压缩

### 4. 去背景

- 纯色背景一键去除（本地色度分析，无需模型下载）

## 界面

- 左列：输入图片 + 「设置」大卡片（模板 / 引擎 / 参数 / 预处理 / 后处理 / 输出 六个切换页，点谁显示谁）
- 右列：主操作按钮 + 前后对比预览 + 下载（SVG / EPS）
- 优化压缩页对「CorelDRAW X4 等老软件」做了兼容输出（绝对坐标 + 内联样式）

## 运行

```bash
npm install
npm run dev
```

然后打开 http://127.0.0.1:5188

> 必须通过 HTTP 访问，直接双击 `index.html`（file://）会因浏览器安全策略无法加载 wasm。

## 目录结构

```
index.html            界面与样式
app.js                应用逻辑（ESM）
preprocess.js         位图预处理（降采样 / 去噪 / 双边滤波 / 颜色量化）
merge-paths.js        矢量后处理（同色合并 / 碎块清理 / 边缘平滑）
eps-export.js         SVG → CMYK EPS 转换
svg-compat.js         老软件兼容模式输出
matte.js              去背景
cmyk.js               RGB → CMYK 分色
serve.mjs             本地静态服务器
build.mjs             构建 dist/
build-vtracer.mjs     生成 vendor/vtracer.js 的脚本
deploy.mjs            Cloudflare Pages 部署
vendor/               引擎文件（见下表）
```

## 引擎与依赖

| 引擎 / 库 | 来源 | 许可 | 用途 |
|---|---|---|---|
| VTracer | `@visioncortex/vtracer` | MIT OR Apache-2.0 | 彩色描摹（官方 wasm 构建） |
| Potrace | `esm-potrace-wasm` | GPL-2.0 | 黑白描摹、彩色海报化 |
| resvg | `@resvg/resvg-wasm` | MPL-2.0 | SVG → 位图渲染 |
| SVGO | `svgo` | MIT | SVG 优化压缩 |
| Paper.js | `paper` | MIT | 几何布尔并集、路径分析 |

### 为什么需要 `build-vtracer.mjs`

官方 npm 包发布的是 **wasm-bindgen `nodejs` target**，它用 `require('fs').readFileSync()` 加载 wasm，浏览器里无法直接运行。

`build-vtracer.mjs` 把末尾的 node 初始化片段替换成浏览器可用的
`fetch + WebAssembly.instantiate`，输出 `vendor/vtracer.js`。

升级依赖后重新执行 `npm run build:engine` 即可。

## 能力边界

这个工具严格限定在**纯前端能做到的范围内**：

**能做**
- 位图 ⇄ 矢量（WASM 引擎，质量好、速度快）
- SVG → CMYK EPS（自研转换器，面向印刷）
- SVG 生态内转换与优化压缩
- 纯色背景去除

**做不到**（需要服务端引擎或原厂内核）
- AI / PS / PDF 等 PostScript 系复合格式（EPS 是自研的有限子集输出，不是完整 PostScript 解析）
- CDR / CDT / CMX / XAR / SK1 等专有二进制格式
- 复杂背景的智能抠图（当前仅支持纯色背景）

## 部署

### Cloudflare Pages（当前使用）

```
https://vectorkit.pages.dev
```

项目名 `vectorkit`，生产分支 `main`。设置好凭据后可一键发布：

```bash
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_ACCOUNT_ID=xxx
npm run deploy          # 等价于 build.mjs + wrangler pages deploy dist
```

### 其他静态托管

纯静态站点，把 `dist/` 里的内容（`index.html`、`app.js`、`vendor/`）传上去即可，
无需构建步骤、无需服务端。

> ⚠️ `.wasm` 文件必须以 `Content-Type: application/wasm` 返回。
> 若被当成 `application/octet-stream`，浏览器会因 MIME 校验拒绝加载引擎。
> Cloudflare Pages / Netlify / Vercel 默认正确，自建 Nginx 需手动加 `application/wasm` 映射。

## 许可提醒

- VTracer / Potrace 均为独立进程式 WASM 调用，商业项目请自行复核各自许可证条款。
- Potrace（`esm-potrace-wasm`）为 **GPL-2.0**，若用于闭源商业产品需谨慎评估。
