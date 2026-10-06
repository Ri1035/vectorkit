# CHANGELOG — 位图转矢量工具（Vector Magic 复刻版）

版本管理规则：每次交付/发布前，将当前可运行 HTML 复制到 `versions/`，命名 `位图转矢量工具_vX.Y.Z.html`；本文件记录变更摘要。详细过程见 `开发日志.md`。

| 版本 | 日期 | 阶段 | 变更摘要 | 验证 | 快照 |
|---|---|---|---|---|---|
| v1.0.0 | 2026-10-04 | P0+P1 | 首个可交付版本：上传（拖拽/选择 JPG/PNG/BMP/GIF）→ 参数面板 → VTracer 转换 → 原图/矢量并排对比 → 缩放 → 下载 SVG；内置示例图；wasm 引擎内嵌、file:// 离线可用 | 引擎 Node 测试通过（BMP→SVG 2980B 合法）；shot.py 桌面+移动零报错；端到端 AUTODEMO_OK（路径>0） | 无文件快照（版本管理此后建立，仅日志记录） |
| v1.1.0 | 2026-10-04 | P2 编辑器 | 新增转换后编辑：浏览/改色/油漆桶/节点 四模式；点选区域改色、油漆桶直接上色、贝塞尔节点+手柄拖拽实时改路径；快照式撤销/重做（50 步）；修复颜色统计大写 hex 误判 | node --check 通过；端到端 EDIT_OK（选中→叠加层锚点→改色→节点拖拽改 d→撤销，桌面+移动零报错） | `versions/位图转矢量工具_v1.1.0.html` |
| v1.2.0 | 2026-10-04 | 质量升级 | 新增「质量」档位（快速/标准/高质量，默认高质量）；高质量档对位图 2× 平滑超采样后走 RGBA 通道（等效亚像素精度）；联动滤镜/简化/优化/色彩精度宏；统一 pathPrecision=1；超大图自动限幅（>4000px 缩比例）；界面标注 v1.2.0；修复 label for 指向无效 | node --check 通过；端到端 QC_OK（高质量 640×480→1280×960 走 vectorize_rgba、快速档 1×、路径>0，零报错）；lint 无死按钮 | `versions/位图转矢量工具_v1.2.0.html` |
| v1.3.0 | 2026-10-06 | 导出+CMYK | 新增 **EPS 导出**（SVG→PostScript：moveto/lineto/curveto/closepath+fill，y 轴翻转；CMYK 指定色走 `setcmykcolor`，其余走 `setrgbcolor`）；新增 **CMYK 颜色选择**（工具栏 CMYK 展开 C/M/Y/K 0-100% 输入，实时 CMYK→RGB 应用到改色/油漆桶，CMYK 值随路径记录供 EPS 精确保真）；项目发布 GitHub（Vector-DB）+ Cloudflare Pages；新增 README；界面标注 v1.3.0 | node --check 通过；端到端 EPS_OK（CMYK→RGB 换算 #ff0000/#00ffff 正确、EPS 含 setcmykcolor/moveto/curveto/%%EOF，零报错）；shot.py 桌面+移动零错误、无死按钮 | `versions/位图转矢量工具_v1.3.0.html` |
| v1.4.0 | 2026-10-06 | 质量修复 | **修复参数从未生效的重大 bug**：wasm 版引擎只认 snake_case 字段（`color_precision`/`filter_speckle`/`binary_threshold`/`watershed_detail`/`max_colors`/`path_precision`…），此前传的 camelCase（`colorPrecision` 等）被引擎静默忽略 → 一直跑引擎默认参数（色桶大、叠层堆叠、噪点过滤大），导致多色图颜色被合并、分块差。v1.4.0 全面改为 snake_case 并重调质量宏：高质量 `color_precision=2`（近似色精细保留）+ `filter_speckle=0`（不丢小色块）+ `hierarchical=cutout`（挖洞式分块、每色独立无叠层）；标准 precision=4/speckle=1；快速 precision=8/speckle=4 | 诊断矩阵：24 区分色图 25 色/25 路径全保留；16 级近似渐变 **2 色 → 16 色全保留**；端到端（真实 loadFile→转换→EPS）16 色/16 路径、EPS 正常、零 console 错误 | `versions/位图转矢量工具_v1.4.0.html` |

## 待办（P3，部分开工）
- ~~导出 EPS~~ ✅（v1.3.0）
- 导出 PDF / AI / DXF
- 批量处理
- 编辑器增强：增/删节点、同色全局替换（Shift）等（待用户确认）

## 已知限制
- 编辑模式仅支持 M/L/C/Z 路径命令（VTracer 输出即此四类）；其他命令的路径可改色、不可节点编辑。
- 撤销/重做为整 SVG 快照式，单次拖拽算一步。
- 2× 超采样对超大图自动限幅，超高分辨率照片的内存/耗时受浏览器限制。
- EPS 导出基于当前编辑态 DOM（含改色/节点编辑后的结果）；CMYK 色值在撤销/重做后回退为 RGB 近似值（EPS 改走 setrgbcolor）。
