/* ============================================================
 * 位图预处理（矢量化之前）
 *
 * 解决「多色图形产生过多色块」的根源问题：描摹引擎按颜色聚类分区，
 * 输入图颜色种类越多，输出路径条数越多。这里在送入引擎前先把位图
 * 处理成「干净、有限色数」的状态：
 *
 *   1. 降采样      —— 色块数随像素数增长，超出目标物理尺寸的部分是纯浪费
 *   2. 中值滤波    —— 清掉孤立的噪点像素（会产生独立色块/碎块）
 *   3. 双边滤波    —— 保边平滑：抹平渐变过渡与纹理，但保留轮廓边界
 *   4. 颜色量化    —— 中值切割，把颜色数压到指定上限
 *
 * 顺序有讲究：先去噪再平滑，最后量化。若先量化，滤波引入的中间色
 * 会重新扩散色数，量化白做。
 *
 * 全部为自主实现，零额外依赖（不使用 opencv.js 等 8MB+ 的 wasm）。
 * ============================================================ */

/* ============================ 基础工具 ============================ */

function cloneData(src) {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ============================ 1. 降采样 ============================ */

/**
 * 按长边上限降采样（保持宽高比，不放大）。
 * @param {ImageData} src
 * @param {number} maxSide 长边上限像素；<=0 或大于原尺寸则不处理
 * @returns {ImageData}
 */
export function downscaleImageData(src, maxSide) {
  if (!maxSide || maxSide <= 0) return src;
  const long = Math.max(src.width, src.height);
  if (long <= maxSide) return src;

  const scale = maxSide / long;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));

  const from = makeCanvas(src.width, src.height);
  from.getContext('2d').putImageData(src, 0, 0);

  const to = makeCanvas(w, h);
  const ctx = to.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/* ============================ 1b. 上采样 ============================ */

/**
 * 等比放大（高质量插值）。小图先放大 2× 再描摹，
 * 抗锯齿边缘的台阶宽度减半，描摹输出天然更平滑。
 * @param {ImageData} src
 * @param {number} factor 放大倍数（2 = 2×）
 * @returns {ImageData}
 */
export function upsampleImageData(src, factor = 2) {
  const w = Math.round(src.width * factor);
  const h = Math.round(src.height * factor);
  if (w < 1 || h < 1 || w > 8000 || h > 8000) return src;

  const from = makeCanvas(src.width, src.height);
  from.getContext('2d').putImageData(src, 0, 0);

  const to = makeCanvas(w, h);
  const ctx = to.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/* ============================ 2. 中值滤波 ============================ */

/**
 * 3×3 中值滤波：去除孤立噪点。alpha < 8 的像素（透明）原样保留，
 * 参与邻域时也会被跳过，避免透明区域的颜色渗入。
 */
export function medianFilter(src) {
  const { width: w, height: h } = src;
  const out = cloneData(src);
  const sp = src.data, dp = out.data;
  const buf = new Uint8Array(9);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const ci = (y * w + x) * 4;
      if (sp[ci + 3] < 8) continue;                 // 中心为透明：不动
      for (let k = 0; k < 3; k++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((y + dy) * w + (x + dx)) * 4;
            if (sp[i + 3] < 8) continue;
            buf[n++] = sp[i + k];
          }
        }
        if (!n) continue;
        // 插入排序取中值（n ≤ 9，比完整排序快）
        for (let a = 1; a < n; a++) {
          const v = buf[a];
          let b = a - 1;
          while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b--; }
          buf[b + 1] = v;
        }
        dp[ci + k] = buf[n >> 1];
      }
    }
  }
  return out;
}

/* ============================ 3. 双边滤波 ============================ */

const BILATERAL_LEVELS = {
  1: { radius: 1, sigmaSpace: 1.0, sigmaRange: 28 },
  2: { radius: 2, sigmaSpace: 1.6, sigmaRange: 40 },
  3: { radius: 3, sigmaSpace: 2.2, sigmaRange: 52 }
};

/**
 * 双边滤波（保边平滑）。
 * 空间权重与值域权重都预计算成查找表，三个通道共用同一个由亮度差
 * 决定的权重（标准做法，避免每通道重复计算，约快 3 倍）。
 *
 * @param {ImageData} src
 * @param {1|2|3} level 强度档位（越大越平滑，半径 1/2/3）
 */
export function bilateralFilter(src, level = 2) {
  const cfg = BILATERAL_LEVELS[level] || BILATERAL_LEVELS[2];
  const r = cfg.radius;
  const { width: w, height: h } = src;
  const out = cloneData(src);
  const sp = src.data, dp = out.data;

  // 空间权重表
  const size = r * 2 + 1;
  const spatial = new Float32Array(size * size);
  let sSum = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      const v = Math.exp(-d2 / (2 * cfg.sigmaSpace * cfg.sigmaSpace));
      spatial[(dy + r) * size + (dx + r)] = v;
      sSum += v;
    }
  }
  for (let i = 0; i < spatial.length; i++) spatial[i] /= sSum;

  // 值域权重表（0–255 亮度差）
  const RANGE_LUT = new Float32Array(256);
  for (let d = 0; d < 256; d++) {
    RANGE_LUT[d] = Math.exp(-(d * d) / (2 * cfg.sigmaRange * cfg.sigmaRange));
  }

  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    lum[p] = 0.299 * sp[i] + 0.587 * sp[i + 1] + 0.114 * sp[i + 2];
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (y * w + x) * 4;
      if (sp[ci + 3] < 8) continue;
      const cl = lum[y * w + x];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const ni = (yy * w + xx) * 4;
          if (sp[ni + 3] < 8) continue;
          const nl = lum[yy * w + xx];
          let d = (cl - nl) | 0;
          if (d < 0) d = -d;
          const wgt = spatial[(dy + r) * size + (dx + r)] * RANGE_LUT[d > 255 ? 255 : d];
          sr += sp[ni] * wgt;
          sg += sp[ni + 1] * wgt;
          sb += sp[ni + 2] * wgt;
          sw += wgt;
        }
      }
      if (sw > 0) {
        dp[ci] = sr / sw;
        dp[ci + 1] = sg / sw;
        dp[ci + 2] = sb / sw;
      }
    }
  }
  return out;
}

/* ============================ 4. 颜色量化 ============================ */

const BITS = 5;                          // 每通道 5 bit → 32768 个色箱
const SHIFT = 8 - BITS;
const BINS = 1 << (BITS * 3);

/** 统计非空色箱数量（近似唯一颜色数，用于提示） */
export function countColors(src) {
  const seen = new Uint8Array(BINS);
  const p = src.data;
  let n = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8) continue;
    const idx = ((p[i] >> SHIFT) << (BITS * 2)) | ((p[i + 1] >> SHIFT) << BITS) | (p[i + 2] >> SHIFT);
    if (!seen[idx]) { seen[idx] = 1; n++; }
  }
  return n;
}

/**
 * 中值切割颜色量化（median cut）。
 *
 * 做法：先建 5-bit/通道 的直方图（32768 箱），再用「反复切割当前跨度最大的
 * 箱子、按像素数取中位」的方式分成 maxColors 个簇，每簇取像素加权平均色，
 * 最后生成 32768 项 LUT 一次性映射全图。
 *
 * 相比逐像素聚类（K-means）的好处：速度与像素数近似线性，且不受初始值影响。
 *
 * @param {ImageData} src
 * @param {number} maxColors 目标色数（2–64），超出范围则不处理
 * @returns {{imageData: ImageData, colorsBefore: number, colorsAfter: number}}
 */
export function quantizeMedianCut(src, maxColors, opts = {}) {
  /* splitMode: 'range' = 按色域中位切分（推荐，保证颜色多样性，适合纯色块插画）
   *            'count' = 按像素数中位切分（旧行为，背景占比大时会挤掉前景色）
   * protectBackground: 占比 > 40% 的主导色锁定为独立簇，不参与切割竞争
   * weightCount: 像素数开方加权，降低大面积色块对簇分配的支配 */
  const { splitMode = 'range', protectBackground = true, weightCount = true } = opts;
  const { width: w, height: h } = src;
  const p = src.data;

  if (!maxColors || maxColors < 2 || maxColors > 64) {
    return { imageData: src, colorsBefore: 0, colorsAfter: 0 };
  }
  const wt = n => (weightCount ? Math.sqrt(n) : n);

  /* --- 直方图：每个色箱的像素数 + RGB 累加 --- */
  const count = new Float64Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  const bins = [];

  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8) continue;
    const r = p[i], g = p[i + 1], b = p[i + 2];
    const idx = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    if (count[idx] === 0) bins.push(idx);
    count[idx]++;
    sumR[idx] += r; sumG[idx] += g; sumB[idx] += b;
  }
  if (bins.length <= maxColors) {
    return { imageData: src, colorsBefore: bins.length, colorsAfter: bins.length };
  }

  const dec = (idx, ch) => {
    const shift = ch === 0 ? BITS * 2 : ch === 1 ? BITS : 0;
    return (idx >> shift) & ((1 << BITS) - 1);
  };

  /* --- 初始簇 --- */
  const makeBox = (list, ch) => {
    let lo = 255, hi = 0, total = 0;
    for (const idx of list) {
      const v = dec(idx, ch);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      total += wt(count[idx]);
    }
    return { list, ch, range: hi - lo, total, lo, hi };
  };

  const rank = box => {
    let best = -1, bestRange = -1;
    for (let ch = 0; ch < 3; ch++) {
      let lo = 255, hi = 0;
      for (const idx of box.list) {
        const v = dec(idx, ch);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const range = hi - lo;
      // 用「跨度 × log(像素数)」兼顾色域宽度与重要程度
      const score = range * Math.log(box.total + 1);
      if (score > bestRange) { bestRange = score; best = ch; }
    }
    box.ch = best;
    box.range = bestRange;
    return box;
  };

  /* 背景保护：找出占比 > 40% 的主导色箱，锁定为独立簇 */
  const boxes = [];
  let cutBins = bins;
  if (protectBackground) {
    let totalPx = 0, topIdx = -1, topPx = 0;
    for (const idx of bins) {
      totalPx += count[idx];
      if (count[idx] > topPx) { topPx = count[idx]; topIdx = idx; }
    }
    if (totalPx > 0 && topPx / totalPx > 0.4) {
      boxes.push(makeBox([topIdx], 0));
      cutBins = bins.filter(idx => idx !== topIdx);
    }
  }
  cutBins = cutBins.slice();
  const cutBox = makeBox(cutBins, 0);
  if (cutBins.length) boxes.push(rank(cutBox));
  // 计算每个轴的跨度，选最大者作为切割轴


  while (boxes.length < maxColors) {
    // 选当前最该切的簇：跨度最大且可切（元素 > 1）
    let target = -1, targetScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].list.length < 2) continue;
      const b = rank(boxes[i]);
      if (b.range > targetScore) { targetScore = b.range; target = i; }
    }
    if (target < 0) break;                          // 无可切簇（颜色数已用尽）

    const box = boxes[target];
    const ch = box.ch;
    box.list.sort((a, b) => dec(a, ch) - dec(b, ch));

    /* 切割位置：
     *   range 模式（默认）取颜色跨度中点——保证两侧颜色多样性，
     *     纯色块插画（大量背景 + 少量前景）不会被背景像素数带偏；
     *   count 模式（旧行为）按像素数中位切分 */
    let cut = 0;
    if (splitMode === 'range') {
      const lo = dec(box.list[0], ch);
      const hi = dec(box.list[box.list.length - 1], ch);
      const mid = (lo + hi) / 2;
      let i = 0;
      while (i < box.list.length - 1 && dec(box.list[i], ch) < mid) i++;
      cut = i > 0 ? i : 1;
      if (cut >= box.list.length) cut = box.list.length - 1;
    } else {
      let acc = 0, half = box.total / 2;
      for (let i = 0; i < box.list.length - 1; i++) {
        acc += wt(count[box.list[i]]);
        if (acc >= half) { cut = i + 1; break; }
      }
      if (cut <= 0) cut = 1;
      if (cut >= box.list.length) cut = box.list.length - 1;
    }
    const left = box.list.slice(0, cut);
    const right = box.list.slice(cut);
    boxes.splice(target, 1, rank(makeBox(left, 0)), rank(makeBox(right, 0)));
  }

  /* --- 生成 LUT --- */
  const lutR = new Uint8Array(BINS);
  const lutG = new Uint8Array(BINS);
  const lutB = new Uint8Array(BINS);
  for (const box of boxes) {
    let n = 0, r = 0, g = 0, b = 0;
    for (const idx of box.list) {
      n += count[idx];
      r += sumR[idx]; g += sumG[idx]; b += sumB[idx];
    }
    if (!n) continue;
    const ar = Math.round(r / n), ag = Math.round(g / n), ab = Math.round(b / n);
    for (const idx of box.list) {
      lutR[idx] = ar; lutG[idx] = ag; lutB[idx] = ab;
    }
  }

  /* --- 应用 --- */
  const out = cloneData(src);
  const dp = out.data;
  for (let i = 0; i < dp.length; i += 4) {
    if (dp[i + 3] < 8) continue;
    const idx = ((dp[i] >> SHIFT) << (BITS * 2)) | ((dp[i + 1] >> SHIFT) << BITS) | (dp[i + 2] >> SHIFT);
    dp[i] = lutR[idx];
    dp[i + 1] = lutG[idx];
    dp[i + 2] = lutB[idx];
  }

  return { imageData: out, colorsBefore: bins.length, colorsAfter: boxes.length };
}


/* ============================ 5. 内部同色保护 ============================ */

/**
 * 内部同色保护：当「前景元素」与「背景」颜色相同时（典型：白色插画的眼白高光、
 * 图案里的白点），描摹引擎会把该颜色整体当作背景层省略，导致这些前景元素丢失。
 *
 * 做法：连通域分析找出「与图像边缘相连」的背景区域，把它的颜色轻微偏移
 * （如纯白 #FFFFFF → #FCFCFC）；被其他颜色包围的同色区域（眼白、内部白点）
 * 保持原色——于是两者成为不同色层，内部元素得以保留。
 *
 * @param {ImageData} src
 * @param {Object} [opts]
 * @param {number} [opts.tolerance=14] 与背景色的通道容差
 * @param {number} [opts.shade=3] 背景色偏移量
 * @returns {{imageData: ImageData, changed: number, bg: number[]|null}}
 */
export function protectInteriorSameColor(src, opts = {}) {
  /* 两个关键参数（互为约束，改动请先读这里）：
   *   tolerance —— flood fill 的「同色」判定容差。必须**小于**「背景色与前景同色区的色差」，
   *                否则前景（如眼白高光，与背景仅差 7）会被误判成背景一起被偏移掉，保护失效。
   *               （实测：Bon Cho 图背景 248 / 眼白 255，故用 4）
   *   shade     —— 背景色偏移量。必须**明显大于**引擎的层间差异阈值（layerDifference 16）：
   *                实测 16 恰好临界会被引擎吞掉，30 才稳定分层。偏移后的背景色会在
   *                输出阶段由 restoreBackgroundColor 还原回原色，用户无感知。 */
  const { tolerance = 4, shade = 30 } = opts;
  const { width: w, height: h, data } = src;
  if (w < 8 || h < 8) return { imageData: src, changed: 0, bg: null };

  /* 1) 从四边取样确定背景色
   *    注意：必须用**精确 RGB 众数**，不能用色箱中心——箱中心与实际像素差可达 7，
   *    会超过下面的 tolerance 导致背景识别失败（实测踩过这个坑）。 */
  const hist = new Map();
  const sample = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 8) return;
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(k, (hist.get(k) || 0) + 1);
  };
  for (let x = 0; x < w; x += 3) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += 3) { sample(0, y); sample(w - 1, y); }
  let bgKey = -1, bgHit = 0;
  for (const [k, c] of hist) if (c > bgHit) { bgHit = c; bgKey = k; }
  if (bgKey < 0) return { imageData: src, changed: 0, bg: null };
  const bgR = (bgKey >> 16) & 255;
  const bgG = (bgKey >> 8) & 255;
  const bgB = bgKey & 255;

  /* 2) 从四边 flood fill：与边缘相连的同色像素 = 背景 */
  const near = i => data[i + 3] >= 8
    && Math.abs(data[i] - bgR) <= tolerance
    && Math.abs(data[i + 1] - bgG) <= tolerance
    && Math.abs(data[i + 2] - bgB) <= tolerance;

  const isBg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const seed = (x, y) => {
    const pi = y * w + x;
    if (isBg[pi]) return;
    if (!near(pi * 4)) return;
    isBg[pi] = 1; queue[qt++] = pi;
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (qh < qt) {
    const pi = queue[qh++];
    const px = pi % w, py = (pi - px) / w;
    if (px > 0) { const n = pi - 1; if (!isBg[n] && near(n * 4)) { isBg[n] = 1; queue[qt++] = n; } }
    if (px < w - 1) { const n = pi + 1; if (!isBg[n] && near(n * 4)) { isBg[n] = 1; queue[qt++] = n; } }
    if (py > 0) { const n = pi - w; if (!isBg[n] && near(n * 4)) { isBg[n] = 1; queue[qt++] = n; } }
    if (py < h - 1) { const n = pi + w; if (!isBg[n] && near(n * 4)) { isBg[n] = 1; queue[qt++] = n; } }
  }

  /* 3) 背景像素统一为同一个偏移色，内部同色区域保持原样。
   *    关键：必须「统一赋值」而不是「逐像素偏移」——JPEG 压缩会让背景存在 ±3 的噪声，
   *    逐像素偏移会把噪声放大成 223–227 的多个近似色，使背景色复杂度暴增，
   *    进而干扰引擎分层与颜色量化（曾导致量化后整图变成一块）。
   *    统一赋值同时起到「背景去噪」的作用。 */
  const out = cloneData(src);
  const dp = out.data;
  const shift = (v) => (v >= 128 ? Math.max(0, v - shade) : Math.min(255, v + shade));
  const bgR2 = shift(bgR), bgG2 = shift(bgG), bgB2 = shift(bgB);
  let changed = 0;
  for (let pi = 0; pi < w * h; pi++) {
    if (!isBg[pi]) continue;
    const i = pi * 4;
    dp[i] = bgR2;
    dp[i + 1] = bgG2;
    dp[i + 2] = bgB2;
    changed++;
  }
  if (!changed) return { imageData: src, changed: 0, bg: [bgR, bgG, bgB] };
  return { imageData: out, changed, bg: [bgR, bgG, bgB] };
}


/* ============================ 6. 主色归并（色块整合） ============================
 * 插画本质上只有少数几种「主色」，其余像素是抗锯齿过渡与 JPEG 压缩噪点。
 * 这些杂色会被描摹引擎切成大量碎块（实测一张 5 色系插画可输出 673 个色块）。
 *
 * 做法（与中值切割量化的关键区别）：
 *   1. 按像素数排序色箱 → 非极大值抑制提取「主色」（保证主色不被背景吃掉）
 *   2. 每个像素归并到最近主色（色差 ≤ mergeDist 才归一，超出则保留原色）
 *   3. 归并是像素级的，同色相连区域自然合并（即空间连通约束）
 *
 * @param {ImageData} src
 * @param {Object} [opts]
 * @param {number} [opts.paletteSize=24] 主色数量上限
 * @param {number} [opts.minSep=20]      主色之间的最小色差（非极大值抑制）
 * @param {number} [opts.mergeDist=40]   像素归并到主色的最大色差
 * @returns {{imageData: ImageData, colorsBefore: number, colorsAfter: number, palette: number[][]}}
 */
export function mergeToPalette(src, opts = {}) {
  const { paletteSize = 24, minSep = 20, mergeDist = 40 } = opts;
  const { data } = src;
  if (!data || !data.length) return { imageData: src, colorsBefore: 0, colorsAfter: 0, palette: [] };

  /* 1) 直方图（5bit 箱） */
  const count = new Float64Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  const bins = [];
  const decBox = (idx, ch) => {
    const shift = ch === 0 ? BITS * 2 : ch === 1 ? BITS : 0;
    return ((idx >> shift) & ((1 << BITS) - 1)) * (256 / (1 << BITS)) + (128 / (1 << BITS));
  };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const idx = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    if (count[idx] === 0) bins.push(idx);
    count[idx]++;
    sumR[idx] += r; sumG[idx] += g; sumB[idx] += b;
  }
  if (bins.length <= paletteSize) {
    return { imageData: src, colorsBefore: bins.length, colorsAfter: bins.length, palette: [] };
  }

  /* 2) 非极大值抑制提取主色：按像素数降序，与已选主色色差 ≥ minSep 才入选 */
  bins.sort((a, b) => count[b] - count[a]);
  const palette = [];
  const sep2 = minSep * minSep;
  for (const idx of bins) {
    const n = count[idx];
    const mr = sumR[idx] / n, mg = sumG[idx] / n, mb = sumB[idx] / n;
    let ok = true;
    for (const p of palette) {
      const dr = p[0] - mr, dg = p[1] - mg, db = p[2] - mb;
      if (dr * dr + dg * dg + db * db < sep2) { ok = false; break; }
    }
    if (!ok) continue;
    palette.push([mr, mg, mb]);
    if (palette.length >= paletteSize) break;
  }
  if (palette.length < 2) {
    return { imageData: src, colorsBefore: bins.length, colorsAfter: bins.length, palette: [] };
  }

  /* 3) 构建 LUT：每个色箱 → 最近主色（色差超 mergeDist 则保留自身均值） */
  const lutR = new Uint8Array(BINS);
  const lutG = new Uint8Array(BINS);
  const lutB = new Uint8Array(BINS);
  const md2 = mergeDist * mergeDist;
  for (const idx of bins) {
    const n = count[idx];
    const mr = sumR[idx] / n, mg = sumG[idx] / n, mb = sumB[idx] / n;
    let best = -1, bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const p = palette[k];
      const dr = p[0] - mr, dg = p[1] - mg, db = p[2] - mb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best >= 0 && bestD <= md2) {
      lutR[idx] = Math.round(palette[best][0]);
      lutG[idx] = Math.round(palette[best][1]);
      lutB[idx] = Math.round(palette[best][2]);
    } else {
      lutR[idx] = Math.round(mr);
      lutG[idx] = Math.round(mg);
      lutB[idx] = Math.round(mb);
    }
  }

  /* 4) 应用 */
  const out = cloneData(src);
  const dp = out.data;
  for (let i = 0; i < dp.length; i += 4) {
    if (dp[i + 3] < 8) continue;
    const idx = ((dp[i] >> SHIFT) << (BITS * 2)) | ((dp[i + 1] >> SHIFT) << BITS) | (dp[i + 2] >> SHIFT);
    dp[i] = lutR[idx];
    dp[i + 1] = lutG[idx];
    dp[i + 2] = lutB[idx];
  }
  const after = new Set();
  for (let i = 0; i < dp.length; i += 4) {
    if (dp[i + 3] < 8) continue;
    after.add(((dp[i] >> SHIFT) << (BITS * 2)) | ((dp[i + 1] >> SHIFT) << BITS) | (dp[i + 2] >> SHIFT));
  }
  return { imageData: out, colorsBefore: bins.length, colorsAfter: after.size, palette };
}


/* ============================ 7. 内部元素保护（方案 E）============================
 * 问题：描摹引擎的分层策略会把「与画布底色同色、且被前景包围」的小元素
 * 当作背景处理 —— 典型是白色插画的眼白高光、图案内部的白点，它们会整体消失。
 *
 * 与前代方案的对比（重要）：
 *   ✗ 旧「内部同色保护」= 改**背景**色 → 引擎会额外描摹一层背景色区域 →
 *     其抗锯齿边缘变成沿图形轮廓的大量碎路径（用户实测反馈否决）
 *   ✓ 本方案 = 只微调**前景元素**的颜色（背景完全不动）→ 元素与背景区分开被保留，
 *     且不会多出背景层 → 无碎轮廓
 *
 * 颜色偏移是可逆的（统一 shift），矢量化完成后由 restoreProtectedColors() 还原原色，
 * 用户拿到的颜色与原始素材一致。
 *
 * @param {ImageData} src
 * @param {Object} [opts]
 * @param {number} [opts.shift=16] 颜色偏移量（须大于引擎层间差异阈值的一半以上）
 * @param {number} [opts.surroundRatio=0.6] 外环暗色占比门槛（被深色包围）
 * @param {number} [opts.brighten=120] 元素须比周围亮多少（高光特征）
 * @returns {{imageData: ImageData, elements: Array}}
 */
export function protectInteriorElements(src, opts = {}) {
  const { shift = 16, surroundRatio = 0.6, brighten = 120, lumGap = 40,
    minAreaRatio = 1 / 200000, maxAreaRatio = 1 / 400 } = opts;
  const { width: w, height: h, data } = src;
  if (!data || !data.length || w < 8 || h < 8) return { imageData: src, elements: [] };

  const N = w * h;
  const lum = new Float32Array(N);
  for (let i = 0, pi = 0; pi < N; pi++, i += 4) {
    lum[pi] = data[i + 3] < 8 ? -1 : (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const edgeVals = [];
  for (let x = 0; x < w; x += 2) { edgeVals.push(lum[x], lum[(h - 1) * w + x]); }
  for (let y = 0; y < h; y += 2) { edgeVals.push(lum[y * w], lum[y * w + w - 1]); }
  edgeVals.sort((a, b) => a - b);
  const bgLum = edgeVals[Math.floor(edgeVals.length / 2)] || 255;

  const minArea = Math.max(3, Math.round(w * h * minAreaRatio));
  const maxArea = Math.max(400, Math.round(w * h * maxAreaRatio));
  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  const isBright = pi => lum[pi] >= Math.max(150, bgLum - 60);
  const elements = [];
  const out = cloneData(src);
  const dp = out.data;

  for (let start = 0; start < N; start++) {
    if (visited[start] || !isBright(start)) continue;
    let qh = 0, qt = 0;
    queue[qt++] = start; visited[start] = 1;
    let area = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    const members = [];
    while (qh < qt) {
      const pi = queue[qh++];
      const x = pi % w, y = (pi - x) / w;
      area++; sx += x; sy += y;
      const i = pi * 4;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      members.push(pi);
      if (x > 0) { const n = pi - 1; if (!visited[n] && isBright(n)) { visited[n] = 1; queue[qt++] = n; } }
      if (x < w - 1) { const n = pi + 1; if (!visited[n] && isBright(n)) { visited[n] = 1; queue[qt++] = n; } }
      if (y > 0) { const n = pi - w; if (!visited[n] && isBright(n)) { visited[n] = 1; queue[qt++] = n; } }
      if (y < h - 1) { const n = pi + w; if (!visited[n] && isBright(n)) { visited[n] = 1; queue[qt++] = n; } }
    }
    if (area < minArea || area > maxArea) continue;
    if (minX <= 1 || minY <= 1 || maxX >= w - 2 || maxY >= h - 2) continue;   // 贴边 = 背景

    /* 形状规则性：眼白/高光近圆润，纹理缝隙不规则 */
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 2.2) continue;
    if (area / (bw * bh) < 0.6) continue;
    if (Math.max(bw, bh) > Math.max(w, h) * 0.08) continue;

    /* 被深色包围 + 明显亮于周围 */
    const memberSet = new Set(members);
    const ring = new Set();
    for (const pi of members) {
      const x = pi % w, y = (pi - x) / w;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const npi = ny * w + nx;
          if (memberSet.has(npi)) continue;
          ring.add(npi);
        }
      }
    }
    let ringDark = 0, ringTotal = 0, ringLumSum = 0;
    const avgLum = (0.299 * sr + 0.587 * sg + 0.114 * sb) / area;
    for (const pi of ring) {
      if (lum[pi] < 0) continue;
      ringTotal++;
      ringLumSum += lum[pi];
      if (lum[pi] < avgLum - lumGap) ringDark++;
    }
    if (!ringTotal || ringDark / ringTotal < surroundRatio) continue;
    if (avgLum - ringLumSum / ringTotal < brighten) continue;      // 必须明显更亮

    /* 取最亮 25% 像素的平均色作为元素原色 */
    members.sort((a, b) => lum[b] - lum[a]);
    const topN = Math.max(1, Math.round(area * 0.25));
    let tr = 0, tg = 0, tb = 0;
    for (let i = 0; i < topN; i++) {
      const k = members[i] * 4;
      tr += data[k]; tg += data[k + 1]; tb += data[k + 2];
    }
    const from = [Math.round(tr / topN), Math.round(tg / topN), Math.round(tb / topN)];
    if (Math.min(from[0], from[1], from[2]) < 200) continue;        // 只保护浅色（白/近白）

    /* 颜色向「远离底色」方向统一偏移 */
    const dir = avgLum >= 128 ? -1 : 1;
    const to = from.map(v => Math.max(0, Math.min(255, v + dir * shift)));
    for (const pi of members) {
      const i = pi * 4;
      dp[i] = to[0]; dp[i + 1] = to[1]; dp[i + 2] = to[2];
    }
    elements.push({ cx: Math.round(sx / area), cy: Math.round(sy / area), area, from, to });
  }

  if (!elements.length) return { imageData: src, elements: [] };
  return { imageData: out, elements };
}

/* ============================ 主入口 ============================ */

/**
 * 按设置顺序执行预处理。
 * @param {ImageData} src
 * @param {Object} opts
 * @param {number} opts.maxSide     降采样长边上限（0 = 不降采样）
 * @param {boolean} opts.denoise    是否中值去噪
 * @param {number} opts.smooth      双边平滑强度 0–3（0 = 关闭）
 * @param {number} opts.maxColors   颜色数上限（0 = 不限）
 * @param {boolean} opts.upsample   小图自动 2× 上采样（短边 < 800px 时生效）
 * @param {(p:number, label:string)=>void} opts.onProgress
 * @returns {{imageData: ImageData, stats: Object}}
 */
export function preprocess(src, opts = {}) {
  /* interiorProtect（内部同色保护）：默认关闭。
   * 该机制会把背景色偏移以让「与背景同色的前景小元素」被引擎保留，
   * 但代价是引擎会额外描摹出一层「背景色区域」——其抗锯齿边缘会变成
   * 沿图形轮廓的大量碎路径（用户实测反馈："那么多碎轮廓"），
   * 收益（救回眼白）远小于代价。保留实现，待有更精准方案后再启用。 */
  const { maxSide = 0, denoise = false, smooth = 0, maxColors = 0, upsample = false, interiorProtect = false, protectElements = false, paletteMerge = false, onProgress } = opts;
  const t0 = performance.now();
  const steps = [];
  const colorsBefore = countColors(src);
  let img = src;
  let colorAfterQuantize = colorsBefore;
  let upsampled = 0;

  if (maxSide > 0 && Math.max(src.width, src.height) > maxSide) {
    onProgress?.(10, '降采样');
    const before = img.width + '×' + img.height;
    img = downscaleImageData(img, maxSide);
    steps.push(`降采样 ${before} → ${img.width}×${img.height}`);
  }

  if (upsample && Math.min(img.width, img.height) < 800) {
    onProgress?.(20, '小图上采样');
    const before = img.width + '×' + img.height;
    img = upsampleImageData(img, 2);
    upsampled = 2;
    steps.push(`上采样 ${before} → ${img.width}×${img.height}`);
  }

  if (denoise) {
    onProgress?.(35, '中值去噪');
    img = medianFilter(img);
    steps.push('中值去噪');
  }

  if (smooth > 0) {
    onProgress?.(60, '保边平滑');
    img = bilateralFilter(img, smooth);
    steps.push('保边平滑 ' + smooth + ' 档');
  }

  let protectedElements = null;
  if (protectElements) {
    onProgress?.(72, '内部元素保护');
    const pe = protectInteriorElements(img, {});
    if (pe.elements.length) {
      img = pe.imageData;
      protectedElements = pe.elements;
      steps.push(`内部元素保护 ${pe.elements.length} 处`);
    }
  }

  let bgShift = null;
  if (interiorProtect) {
    onProgress?.(76, '内部同色保护');
    const ip = protectInteriorSameColor(img, {});
    if (ip.changed > 0) {
      img = ip.imageData;
      bgShift = { from: ip.bg, shade: 30 };
      steps.push('内部同色保护');
    }
  }

  if (paletteMerge) {
    onProgress?.(85, '主色归并');
    const mp = mergeToPalette(img, typeof paletteMerge === 'object' ? paletteMerge : {});
    img = mp.imageData;
    colorAfterQuantize = mp.colorsAfter || colorsBefore;
    if (mp.colorsBefore > mp.colorsAfter) {
      steps.push(`主色归并 ${mp.colorsBefore} → ${mp.colorsAfter} 色`);
    }
  } else if (maxColors >= 2) {
    onProgress?.(85, '颜色量化');
    const q = quantizeMedianCut(img, maxColors);
    img = q.imageData;
    colorAfterQuantize = q.colorsAfter || colorsBefore;
    if (q.colorsBefore > q.colorsAfter) {
      steps.push(`颜色量化 ${q.colorsBefore} → ${q.colorsAfter} 色`);
    }
  }

  const ms = performance.now() - t0;
  onProgress?.(100, '完成');

  return {
    imageData: img,
    stats: {
      colorsBefore,
      colorsAfter: colorAfterQuantize,
      width: img.width,
      height: img.height,
      bgShift,
      protectedElements,
      rawWidth: src.width,
      rawHeight: src.height,
      upsampled,
      ms,
      steps
    }
  };
}
