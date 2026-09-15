/* ============================================================
 * 纯色背景去除（去白底 / 去纯色底）
 *
 * 面向电商商品图的常见场景：主体 + 单一颜色背景。
 * 这一层是**自主实现**的成熟图像处理算法（非研究性工作），刻意不引入 AI：
 *   - 对纯色背景，颜色阈值 + 软边 + 去色溢出的效果与 AI 相当甚至更干净
 *   - 瞬时完成（1600px 约 30–80ms），可做到拖动滑块实时预览
 *   - 零额外下载，不增加站点体积
 *
 * 复杂背景（人像、毛发、多色场景）请使用 AI 抠图通道。
 * ============================================================ */

/* ---------- alpha 预处理算子：全部可分离，避免 O(r²) ---------- */

/** 可分离盒式模糊（水平 + 垂直两遍），对 Float32Array 原地处理 */
function boxBlur(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(src.length);

  // 水平
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        sum += src[row + xx]; cnt++;
      }
      tmp[row + x] = sum / cnt;
    }
  }

  // 垂直
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0, cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        sum += tmp[yy * w + x]; cnt++;
      }
      src[y * w + x] = sum / cnt;
    }
  }
  return src;
}

/** 可分离最小值滤波（腐蚀）：把半透明边缘向内收缩，吃掉残留的白边
 *  注意：不能命名为 erode —— removeSolidBackground 有同名解构参数会遮蔽它 */
function erodeAlpha(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(src.length);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const v = src[row + xx];
        if (v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const v = tmp[yy * w + x];
        if (v < m) m = v;
      }
      src[y * w + x] = m;
    }
  }
  return src;
}
/** RGB 欧氏距离（带人眼权重） */
function colorDist(r, g, b, kr, kg, kb) {
  const dr = (r - kr) * 0.30;
  const dg = (g - kg) * 0.59;
  const db = (b - kb) * 0.11;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** 平滑阶跃：在 [edge0, edge1] 区间内做三次插值，比线性过渡更自然 */
function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 从图像边缘自动采样背景色（取四角与四边中点的中位数，抗噪）
 * @returns {[number, number, number]}
 */
export function detectBackgroundColor(imageData) {
  const { data, width: w, height: h } = imageData;
  const pick = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const inset = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const samples = [];
  const xs = [inset, Math.round(w / 2), w - 1 - inset];
  const ys = [inset, Math.round(h / 2), h - 1 - inset];

  // 四条边各取 3 点
  for (const x of xs) { samples.push(pick(x, inset)); samples.push(pick(x, h - 1 - inset)); }
  for (const y of ys) { samples.push(pick(inset, y)); samples.push(pick(w - 1 - inset, y)); }

  const med = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  return [med(samples.map(s => s[0])), med(samples.map(s => s[1])), med(samples.map(s => s[2]))];
}

/**
 * 去除纯色背景，返回新的 ImageData（带 alpha 通道）
 *
 * @param {ImageData} src
 * @param {Object}  opts
 * @param {number[]} opts.key        背景色 [r,g,b]；传 null 则自动检测
 * @param {number}  opts.tolerance   颜色容差 0–255（越大去掉越多）
 * @param {number}  opts.softness    边缘软度 0–60，在容差之上再过渡这么多色差
 * @param {number}  opts.despill     去色溢出强度 0–1（消除边缘残留的背景色）
 * @param {number}  opts.feather     羽化半径 0–3（像素）
 * @param {number}  opts.erode       边缘收缩 0–3（像素），吃掉主体外圈残留的背景色描边
 * @param {number}  opts.despeckle   去噪面积阈值 0–200（清理小于该面积的碎块）
 */
export function removeSolidBackground(src, opts = {}) {
  const {
    key = null,
    tolerance = 30,
    softness = 18,
    despill = 0.6,
    erode = 0,
    feather = 1,
    despeckle = 12
  } = opts;

  const w = src.width, h = src.height;
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  const px = out.data;
  const krgb = key && key.length === 3 ? key : detectBackgroundColor(src);
  const [kr, kg, kb] = krgb;

  const t0 = Math.max(0, tolerance);
  const t1 = t0 + Math.max(1, softness);

  /* 1. 生成 alpha：距离背景色越近越透明 */
  const alpha = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const d = colorDist(px[i], px[i + 1], px[i + 2], kr, kg, kb);
    // d < t0 → 完全透明(0)；d > t1 → 完全不透明(1)
    alpha[p] = smoothstep(t0, t1, d);
  }

  /* 2a. 腐蚀：先把边缘向内收 erode 像素，消掉抗锯齿残留的背景色描边 */
  if (erode > 0) erodeAlpha(alpha, w, h, Math.min(3, Math.round(erode)));

  /* 2b. 羽化：可分离盒式模糊，让边缘过渡自然 */
  if (feather > 0) boxBlur(alpha, w, h, Math.min(4, Math.round(feather)));

  /* 3. 去噪：基于连通域的面积过滤，去掉孤立碎块 */
  if (despeckle > 0) {
    const area = Math.max(1, Math.round(despeckle));
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (seen[p] || alpha[p] >= 0.5) continue;   // 只处理"透明"区域
      let sp = 0, comp = [];
      stack[sp++] = p;
      seen[p] = 1;
      while (sp > 0) {
        const cur = stack[--sp];
        comp.push(cur);
        const cx = cur % w, cy = (cur / w) | 0;
        const nb = [
          cx > 0 ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1
        ];
        for (const q of nb) {
          if (q >= 0 && !seen[q] && alpha[q] < 0.5) { seen[q] = 1; stack[sp++] = q; }
        }
      }
      if (comp.length <= area) {
        // 小碎块 → 恢复为不透明（很可能是主体上的深色细节，如眼睛）
        for (const q of comp) alpha[q] = 1;
      }
    }
  }

  /* 4. 写回 alpha + 去色溢出（unpremultiply，消除边缘残留背景色） */
  const despillAmt = clamp01(despill);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const a = alpha[p];
    px[i + 3] = Math.round(a * 255);

    if (despillAmt > 0 && a > 0.01 && a < 0.99) {
      // 半透明边缘像素：把背景色的贡献减掉
      const inv = 1 - a;
      const nr = (px[i] - inv * kr * despillAmt) / (1 - inv * despillAmt);
      const ng = (px[i + 1] - inv * kg * despillAmt) / (1 - inv * despillAmt);
      const nb2 = (px[i + 2] - inv * kb * despillAmt) / (1 - inv * despillAmt);
      px[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      px[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      px[i + 2] = nb2 < 0 ? 0 : nb2 > 255 ? 255 : nb2;
    }
  }

  return { imageData: out, key: krgb };
}

/**
 * 把带 alpha 的 ImageData 合成到指定底色上（不透明输出）
 * @param {ImageData} src
 * @param {number[]} bg [r,g,b]
 */
export function flattenOnto(src, bg = [255, 255, 255]) {
  const [br, bg2, bb] = bg;
  const px = src.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    if (a >= 1) continue;
    px[i] = Math.round(px[i] * a + br * (1 - a));
    px[i + 1] = Math.round(px[i + 1] * a + bg2 * (1 - a));
    px[i + 2] = Math.round(px[i + 2] * a + bb * (1 - a));
    px[i + 3] = 255;
  }
  return src;
}

/** 统计不透明像素占比（用于 UI 提示「保留了多大主体」） */
export function opaqueRatio(src) {
  const px = src.data;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 127) n++;
  return n / (px.length / 4);
}

/**
 * 只把背景变白（不透明），用于"白底化"需求
 */
export function whitenBackground(src, opts = {}) {
  return flattenOnto(removeSolidBackground(src, opts).imageData, [255, 255, 255]);
}
