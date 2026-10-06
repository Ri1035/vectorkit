# Vector-DB — 位图转矢量工具（Vector Magic 复刻版）

> 本地离线 · 单文件 · VTracer wasm 引擎 · 支持 CMYK 与 EPS 导出

一个开箱即用的**位图 → 矢量**转换工具：上传 JPG/PNG/BMP/GIF，自动矢量化，转后在浏览器里直接编辑（改色 / 油漆桶 / 节点拖拽），导出 **SVG / EPS**。整页单 HTML 自包含，引擎 wasm 内嵌，**双击即用、完全离线**，也可部署到任意静态托管（已发布 GitHub Pages / Cloudflare Pages）。

在线体验：[Cloudflare Pages](https://vector-db.pages.dev) ｜ 仓库：[GitHub Vector-DB](https://github.com/Ri1035/Vector-DB)

---

## 功能特性

- **转换**：拖拽或选择图片（JPG / PNG / BMP / GIF），内置示例图一键体验
- **参数面板**：预设（自动/黑白/海报/照片）、拟合模式、最大颜色数、噪点过滤、曲线简化、聚类方式（色彩聚类/黑白阈值/分水岭）、输出优化、固定调色板
- **质量档位**：快速 / 标准 / **高质量**（默认）——高质量档对位图做 2× 平滑超采样后走 RGBA 通道，等效亚像素精度；超大图自动限幅防卡死
- **对比预览**：原图 vs 矢量结果并排，路径 / 颜色 / SVG 体积 / 耗时统计，缩放（适应 / ± / 1:1）
- **转换后编辑**：
  - 改色：点选区域 → 调色板取色
  - 油漆桶：选色后点击区域直接上色
  - 节点：拖拽贝塞尔锚点 / 控制手柄实时改曲线
  - **CMYK**：C/M/Y/K 0-100% 输入（印刷色），实时换算并随路径记录，EPS 导出精确保真
  - 撤销 / 重做（快照式，50 步）
- **导出**：SVG（矢量可缩放）、**EPS**（PostScript，CMYK 走 `setcmykcolor`、其余走 `setrgbcolor`）

## 快速开始

### 本地使用
1. 下载整个项目（保持目录结构，`lib/` 必须与 html 同目录）。
2. 双击打开 `位图转矢量工具.html`（file:// 即可，无需服务器）。
3. 拖入图片或点「载入示例图」→ 调参数 → 「开始转换」→ 编辑 → 「下载 SVG / EPS」。

### 部署（静态托管，二选一）
- **Cloudflare Pages**：部署内容为 `index.html` + `lib/`（见 `deploy/` 目录或按「发布」节构建）。
- 任意静态托管同理：把 `index.html` 与 `lib/` 传到根目录。

## 目录结构

```
bitmap2vector/
├── 位图转矢量工具.html     # 主程序（单文件自包含，当前版本 v1.4.0）
├── lib/
│   ├── vtracer.js          # 浏览器版 VTracer 引擎（wasm 内嵌 base64）
│   ├── _vtracer_wasm.js    # 官方 Node 胶水原始备份（构建输入）
│   └── _vtracer_wasm_bg.wasm # 官方 wasm 本体备份（构建输入）
├── versions/               # 版本快照（v1.0.0 ~ v1.4.0，可回滚）
│   └── 位图转矢量工具_vX.Y.Z.html
├── build_vtracer_lib.py    # 引擎构建脚本（Node 胶水 → 浏览器版）
├── CHANGELOG.md            # 版本变更记录
├── 开发日志.md              # 开发过程与验证日志
└── README.md
```

## 技术栈与引擎

- **UI**：原生 HTML/CSS/JS 单文件，无框架、无构建、无外部 CDN（离线可用）
- **矢量化引擎**：[VTracer](https://github.com/visioncortex/vtracer) `1.0.0-alpha.4`（MIT/Apache-2.0，Rust 内核）
  - 官方 npm 包胶水为 Node 专属；本项目用 `build_vtracer_lib.py` 改造为浏览器版：删 `exports.`、截 Node 尾部、base64 内嵌 wasm、挂 `window.VTracerEngine`（`vectorize_bytes` / `vectorize_rgba`）
  - 重新构建引擎：`python build_vtracer_lib.py`（输入 `lib/_vtracer_wasm.js` + `lib/_vtracer_wasm_bg.wasm` → 输出 `lib/vtracer.js`）
- **EPS 导出**：自研 SVG→PostScript 转换（moveto/lineto/curveto/closepath + fill，y 轴翻转）

## 发布（GitHub + Cloudflare Pages）

```bash
# GitHub（需已配置 git 凭据）
git init
git add -A
git commit -m "v1.3.0: EPS export + CMYK + docs"
git remote add origin https://github.com/<你的用户名>/Vector-DB.git
git push -u origin main

# Cloudflare Pages（需 wrangler）
npm i -g wrangler
$env:CLOUDFLARE_API_TOKEN="<你的 CF token>"
npx wrangler pages project create vector-db --production-branch main
npx wrangler pages deploy deploy --project-name vector-db --branch main
```

> 部署目录 `deploy/` 为构建产物（`index.html` 为 `位图转矢量工具.html` 的部署副本 + `lib/vtracer.js`），不入库。

## 版本历史

| 版本 | 日期 | 摘要 |
|---|---|---|
| v1.0.0 | 2026-10-04 | P0+P1：上传→参数→转换→对比→下载 SVG |
| v1.1.0 | 2026-10-04 | P2 编辑器：改色 / 油漆桶 / 节点拖拽 / 撤销重做 |
| v1.2.0 | 2026-10-04 | 质量档位 + 2× 超采样（等效亚像素精度） |
| v1.3.0 | 2026-10-06 | EPS 导出 + CMYK 颜色 + GitHub/CF 发布 |
| v1.4.0 | 2026-10-06 | **质量修复**：引擎参数字段改 snake_case（修复参数从未生效的 bug），多色图颜色保留与分块质量大幅提升 |

完整变更与验证细节见 [CHANGELOG.md](CHANGELOG.md)。

## Roadmap

- [x] P0+P1 转换主流程（上传/参数/对比/下载）
- [x] P2 转换后编辑器（改色/油漆桶/节点/撤销重做）
- [x] EPS 导出 + CMYK 颜色
- [ ] 导出 PDF / AI / DXF
- [ ] 批量处理
- [ ] 编辑器增强：增/删节点、同色全局替换

## 许可

- 本项目代码：MIT（如商用请自行评估）
- 引擎 [VTracer](https://github.com/visioncortex/vtracer)：MIT / Apache-2.0 双许可
- 本工具为学习复刻项目，与 Vector Magic（vectormagic.com）无任何关联。
