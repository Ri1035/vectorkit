# VectorKit

纯前端矢量转换器 demo。文件的解析、转换、压缩**全部在浏览器本地完成**，不上传任何服务器，也不产生任何网络请求。

- 线上地址：https://vectorkit.pages.dev
- 代码仓库：https://github.com/Ri1035/vectorkit

## 功能

### 1. 位图 → 矢量

- 输入：PNG / JPG / WebP / GIF / BMP
- 双引擎：VTracer（彩色描摹）+ Potrace（黑白描摹 / 彩色海报化）
- 5 个 VTracer 预设 + 4 个 Potrace 预设，参数可微调
- 输出对比预览与统计（体积 / 路径数 / 节点数 / 耗时）

### 2. 矢量 → 位图

- SVG → PNG / WebP / JPEG
- 1×–4× 倍率，透明 / 白 / 黑 / 自定义背景
- 质量与尺寸可调

### 3. 优化 / 压缩

- 移除元数据、注释、空容器
- 坐标精度压缩
- 可选同时输出 SVGZ（gzip）

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
serve.mjs             本地静态服务器
build-vtracer.mjs     生成 vendor/vtracer.js 的脚本
vendor/
  vtracer.js              VTracer 浏览器封装（由脚本生成）
  vtracer_wasm_bg.wasm    VTracer 引擎（652 KB）
  potrace.js              Potrace 引擎（wasm 内嵌，74 KB）
```

## 引擎说明

| 引擎 | 来源 | 许可 | 用途 |
|---|---|---|---|
| VTracer | `@visioncortex/vtracer` | MIT OR Apache-2.0 | 彩色描摹（官方 wasm 构建） |
| Potrace | `esm-potrace-wasm` | GPL-2.0 | 黑白描摹、彩色海报化 |

### 为什么需要 `build-vtracer.mjs`

官方 npm 包发布的是 **wasm-bindgen `nodejs` target**，它用 `require('fs').readFileSync()` 加载 wasm，浏览器里无法直接运行。

`build-vtracer.mjs` 把末尾的 node 初始化片段替换成浏览器可用的
`fetch + WebAssembly.instantiate`，输出 `vendor/vtracer.js`。

升级依赖后重新执行 `npm run build:engine` 即可。

## 能力边界

这个 demo 严格限定在**纯前端能做到的范围内**：

**能做**
- 位图 ⇄ 矢量（WASM 引擎，质量好、速度快）
- SVG 生态内转换与优化压缩

**做不到**（需要服务端引擎或原厂内核）
- AI / EPS / PS 等 PostScript 系格式
- CDR / CDT / CMX / XAR / SK1 等专有二进制格式
- 旧版 VSD

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
