# 平滑边缘 & 色块隔离：多引擎源码拆解 + vectorkit 结合优化方案

> 方法：对**候选引擎源码/接口**做多维拆解（能力面 / 参数面 / 算法面），再对照 **vectorkit 自身源码**，
> 找出可结合的优化点。重点：**平滑边缘** 与 **色块隔离**。
> 日期：2026-10-12　状态：**P0 已实施（v4.4）、P1 已实施（v4.5）、可辨识性修正完成（v4.6：能力集中于 `vmde` 档）**；P1 剩余（palette）与 P2 待做

---

## 一、结论摘要（先看这个）

| 优先级 | 发现 | 影响 |
|---|---|---|
| **P0** | vexctorkit **所有预设**都用 `hierarchical:'stacked'`，**从未使用 `cutout`** | 1.0 的 `cutout` 已改为**真·无缝马赛克（共用边界）**，这正是「色块隔离」的正解 —— 我们却按 0.x 的旧印象（"镂空/有白缝"）回避了它 |
| **P0** | `simplify`（曲线简化）**默认 0 = 关闭**，仅 poster 预设写死 1.5 | VTracer 官方明示：**`--simplify` 才是真正决定输出体积与平滑度的旋钮**（1–2.5 常用，体积可减半） |
| **P0** | 后处理未按 `hierarchical` 分支 | `cutout` 下 `snapAdjacentBoundaries` 冗余、`fitCircleShapes` 可能**破坏共享边界** |
| **P1** | `clustering:'watershed'` 从未使用 | 引擎自带**边缘感知分区**（Cousty 2009），官方称与 cutout 搭配极佳，比我们的 RGB 中值切割更贴物体边界 |
| **P1** | 引擎的 `palette` / `maxColors`（**OKLab** 最近邻量化）未接入 UI | 我们的色块归并是自研 RGB 中值切割，感知均匀性不如 OKLab |
| **P2** | `optimize` / `watershedDetail` / `spliceThreshold` / `adaptiveWindow` 未暴露 | 可进一步压缩体积 / 控制区域数 |

---

## 二、多维源码拆解

### 2.1 VTracer 1.0（**本地已内置** `@visioncortex/vtracer@1.0.0-alpha.4`）

**权威接口**来自包内 `index.d.ts`（不是文档猜测）：

| 选项 | 取值 | 我们是否使用 |
|---|---|---|
| `preset` | `bw` / `poster` / `photo` | ✅ 部分预设 |
| `clustering` | `color-cluster` / `bw` / **`watershed`** | ❌ **watershed 从未使用** |
| `hierarchical` | `stacked` / **`cutout`** | ❌ **cutout 从未使用** |
| `mode` | `pixel` / `polygon` / `spline` | ✅ spline |
| `filterSpeckle` / `colorPrecision` / `layerDifference` / `cornerThreshold` / `lengthThreshold` / `maxIterations` / `spliceThreshold` | 数值 | ✅ 部分 |
| **`simplify`** | 曲线简化容差(px)，省略=关，**建议 1–2.5** | ⚠️ 仅 poster 用 1.5，**默认关** |
| **`palette`** | `#rrggbb[]` 固定调色板（OKLab 最近邻） | ❌ 未接入 |
| **`maxColors`** | 自动量化目标色数 | ✅ UI 有（默认 0） |
| **`optimize`** | 0/1/2 | ⚠️ 仅 poster |
| `binaryThreshold`/`adaptive`/`adaptiveWindow`/`adaptiveT` | 二值模式 | ⚠️ 仅 line 预设用 adaptive |
| **`watershedDetail`** | 分水岭层级切点（默认 128，越大区域越多） | ❌ 未接入 |

**1.0 的关键升级（官方 README 原文要点）**：
1. **`--hierarchical cutout` 现在是"真·无缝马赛克"（gapless tessellation with shared boundaries）**，
   取代旧的"重新聚类"式 cutout —— **即：相邻色块共享同一条边界线，不重叠、不留缝**。← **色块隔离的正解**
2. **`--simplify <tolerance>`**：paper.js 风格曲线简化，"用**最少的 cubic** 在容差内重拟合平滑段"，
   "通常让文件减半"；且在 **cutout 模式下共享边界只简化一次**（两侧共用）→ **平滑且无缝**。
3. **`--clustering watershed`**：像素图上的**分层分水岭**（Cousty et al., TPAMI 2009；Najman 2013），
   产生**内容自适应、跟随物体形状**的区域，官方推荐与 cutout 搭配。
4. **`--palette` / `--max-colors`**：OKLab 空间最近邻吸附。
5. 官方同时说明：`corner-threshold / segment-length / splice-threshold` 已"隐藏"，
   **"真正变动体积与平滑度的是 `--simplify`"**。

> **结论**：我们 1.0 的核心红利（**cutout 无缝 + watershed 分区 + simplify 简化**）**一个都没吃到**。

### 2.2 Potrace（已内置，仅黑白）

`alphamax`(拐角平滑) / `opttolerance`(曲线优化) / `turdsize` / `turnpolicy`。
算法为**最优多边形搜索**（论文可证），输出单一前景轮廓，**天然"色块隔离"**（因为只有黑/白两色）。
→ 对我们的启发：**它的"曲线优化"思路 = 用最少曲线段在容差内拟合**，与 VTracer 的 `simplify` 同源。

### 2.3 ImageTracer.js（纯 JS，与 vectorkit 技术栈同源，便于移植）

源码级选项：
- `ltres`(直线拟合误差) / `qtres`(二次样条拟合误差) / `pathomit`(短路径丢弃) / **`rightangleenhance`**(直角增强，默认 true)
- **`blurradius` + `blurdelta`**：**选择性高斯模糊预处理** —— 只模糊"与邻域差值 < blurdelta"的区域，
  **保边去噪**。这是它抑制"碎边/碎块"的核心手段，我们目前用中值/双边滤波近似之。
- `colorsampling`(0/1/2) / `numberofcolors` / `colorquantcycles`（多次量化解算）/ `palette`
- `layering`(0 顺序 / 1 并行)

→ **可借鉴点**：① `rightangleenhance` 的**直角增强**（对应我们的 `snapAxisAlignedEdges`，但它在**像素域**做，更早更稳）；
② `blurradius/blurdelta` 的**保边模糊**（比我们的双边滤波更可控，且是"差值门限"式）。

### 2.4 AutoTrace

中线（centerline）与轮廓（outline）两条路径 + 样条拟合 + 角点检测。
→ 对我们的启发：**线稿类**输入用"中线化"可得到单线路径（适合签名/指纹），我们暂无此模式。

### 2.5 参考：Vector Magic 原理（另见 `原理与辅助拆解方案.md`）

贝叶斯 MAP 反解抗锯齿生成模型 → **亚像素边界**。**引擎能力上我们追不上**，
但其**离散阶段"把节点数当被优化变量"**的思想，正好对应 VTracer 的 `simplify`。

---

## 三、vectorkit 现状源码拆解

**管线**（`app.js` ~863–986）：
```
preprocess(降采样/上采样/中值/双边/中值切割量化/paletteMerge/方案E)
  → VTracer.vectorize_rgba(rgba, w, h, options)
  → SVGO(可选)
  → mergeSameColorPaths(同色合并/碎块清理minArea/方案C对比度)
  → snapAdjacentBoundaries(方案B：锚点吸附合并到中点)
  → unifyEqualRadiiInSvg(方案D：等半径统一)
  → restoreProtectedColors / restoreBackgroundColor
  → ensureSvgSize / toLegacySvg
```

**参数面**（`app.js` 637–667）：主面板 5 项（filterSpeckle / layerDifference / maxColors /
cornerThreshold / lengthThreshold）+ 高级 6 项（clustering / hierarchical / mode / colorPrecision /
pathPrecision / **simplify 默认 0**）。

**预设**（`app.js` 620–631）：logo / photo / line / poster / pixel —— **全部 `stacked`**；
`simplify` 仅 poster=1.5。

**后处理栈（自研，A–F）**：见 `docs/OPEN_SOURCE_METHODS.md`。与本方案相关的：
- `snapAdjacentBoundaries`（方案 B，`merge-paths.js:1251`）：空间散列找跨路径**错位 ≤1.2px** 的锚点，吸附到中点
- `fitCircleShapes` / `fitAxisAlignedEllipse`（`merge-paths.js:1145/1967`）：把路径**替换为完美圆/椭圆**
- `resampleSimplify` + `smoothContourPoints` + `fitSmoothCurve`（`merge-paths.js:1877/1841/1607`）

---

## 四、可结合的优化点（分阶段、可执行）

### P0-1　启用 `cutout` 真无缝 —— 色块隔离的**正解**
- **改动**：为「插画 / 扁平色块 / 贴纸」类预设增加 `hierarchical:'cutout'`；
  高级面板把 `hierarchical` 的**文案**从"镂空"更正为"**无缝共用边界（马赛克）**"（旧文案源自 0.x 语义，会误导用户）。
- **理由**：1.0 的 cutout 与 0.x 完全不同：**相邻色块共享边界**，从根上消除"重合/留缝"，
  比我们的"事后把错位锚点吸到中点"（方案 B）更彻底。
- **验证**：Baby Happy / Bon Cho，量化指标 = **see-through 像素比**（越接近 0 越好）+ 重叠面积。

### P0-2　把 `simplify` 变成一等公民 —— 平滑边缘 + 减体积
- **改动**：① `simplify` 默认值由 `0` 改为 **`1.0`**（并在 UI 标注"推荐 1.0–2.0"）；
  ② 新增预设 "**平滑曲线**"（`mode:'spline'`, `simplify:1.5`, `hierarchical:'cutout'`）；
  ③ `collectOptions()` 确保 `simplify:0` 时不传（省略=关闭）。
- **理由**：官方定义 `simplify` = "**用最少 cubic 在容差内重拟合平滑段**"，
  与我们 `smoothContourPoints`+`fitSmoothCurve` 的目标**完全重合**，但更成熟，且 cutout 下共享边界只简化一次。
- **风险控制**：`simplify` 过大将磨细节 → 上限 2.5；对"线稿/像素画"预设保持 0。

### P0-3　后处理按 `hierarchical` 分支（避免互相打架）
- **改动**（`app.js` 912–941 区块）：
  - `hierarchical === 'cutout'` 时：**跳过** `snapAdjacentBoundaries`（共享边界已由引擎保证，吸附反而破坏拓扑）；
  - 同时**跳过** `fitCircleShapes`/`fitAxisAlignedEllipse`（把边界换成完美圆会**断开与邻块的共享边**）；
    仅在 `stacked` 下保留这两项。
  - `snapAxisAlignedEdges`（正交吸附）**两种模式都保留**（只动纯直线段，不破坏共享曲线）。
- **理由**：这是**目前最可能"改了就变差"的地方**——必须先分支再加开关。

### P1-1　接入 `watershed` 分区 —— 更贴物体边界的色块
- **改动**：为「贴纸 / 扁平插画」预设提供 `clustering:'watershed'` + `watershedDetail`（如 96–192）；
  高级面板暴露 `watershedDetail` 滑杆。
- **理由**：边缘感知分区 vs 我们的"RGB 中值切割预处理"——前者按**连通域/边缘**成区，色块边界与物体轮廓一致。
- **注意**：watershed 与 `maxColors`（色彩量化）是两条路，**不要**同时强设色数。

### P1-2　颜色归并改用引擎的 OKLab 量化
- **改动**：当用户使用 `maxColors` 或需要"固定配色"时，**优先走引擎 `maxColors` / `palette`**，
  我们自研的 `quantizeMedianCut`+`mergeToPalette` 退化为"引擎不支持时的回退"。
- **理由**：OKLab 是感知均匀空间，色块归并更符合人眼；也减少一次"量化→再量化"的颜色损失。

### P2　其他低风险增益
- 暴露 `optimize`（0/1/2）与 `spliceThreshold`；`mode:'polygon'` 用于"要多边形化/切割友好"的场景；
  线稿预设补 `adaptiveWindow`。

### 借鉴 ImageTracer.js 的两点（跨引擎结合）
- **`rightangleenhance`**：在**预处理阶段**增强近直角 → 让 `snapAxisAlignedEdges` 更稳（我们目前在矢量域做）。
- **`blurradius/blurdelta` 的选择性模糊**：作为 `bilateralFilter` 的替代档，参数更直观（差值门限）。

---

## 五、风险与回归防护（吸取历史教训）

> 本项目有明确教训：**实验性机制必须默认关闭**；曾因"内部同色保护默认开启"导致碎轮廓回归（"还不如 v2.7"）。

1. **默认值只做"低风险、可解释"的改动**：`simplify: 0 → 1.0` 属低风险（官方推荐区间内）；其余新能力以**预设/开关**形式提供，**不改全局默认**。
2. **`cutout` 必须成对处理**（P0-3），否则后处理会破坏共享边界。
3. **每项改动必须过三类图**：贴纸风（Baby Happy）、渐变插画（Bon Cho）、照片；任一退化即回退该项。
4. **量化验收**：锚点数 / 色块数 / see-through 像素比 / ΔE / 文件体积（口径见 `原理与辅助拆解方案.md` 3.3）。

---

## 六、建议实施顺序

| 阶段 | 内容 | 风险 |
|---|---|---|
| **第 1 步** | P0-3（后处理分支）+ P0-1（cutout 上线为可选预设） | 中（需成对） |
| **第 2 步** | P0-2（simplify 默认 1.0 + 新预设 + 文案） | 低 |
| **第 3 步** | P1-1（watershed）+ P1-2（OKLab 量化） | 中 |
| **第 4 步** | P2 + ImageTracer 借鉴项 | 低 |

**验收方式**：每步出「before/after」对照 SVG + 量化表，用户目检通过后再进下一步。
