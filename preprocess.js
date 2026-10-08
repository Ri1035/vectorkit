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
  const { maxSide = 0, denoise = false, smooth = 0, maxColors = 0, upsample = false, onProgress } = opts;
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

  if (maxColors >= 2) {
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
      rawWidth: src.width,
      rawHeight: src.height,
      upsampled,
      ms,
      steps
    }
  };
}
