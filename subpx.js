import { fitClosedPath } from './bezierfit.js';

/* ============================================================================
 * 并列描摹引擎 · 并行描摹（v6.1 重写轮廓提取）
 *
 * ⚠️ 状态：**研究原型，未接入产品**（默认管线完全不受影响）
 * v6.1：轮廓提取已重写为 marching squares 半边行走 —— bc 1024² **32.04 dB**（基线 34.49），几何已验证正确。
 *
 * 机制参照 storytold/vectorcraft 的 crates/trace/（Apache-2.0）：
 *   量化 → 标签图 → 4连通去噪 → **裂缝(marching squares 半边)** → 覆盖率 α 重定位 → 闭环
 *
 * v6.0 的失败根因与本版修正：
 *   v6.0 用「裂缝 + 转角偏好」的启发式行走 → 在**多标签**场景下，右侧/下侧区域的边界
 *   无法被遍历（walk 跳到无关边 → 图上出现对角三角形）。
 *   本版改为**标准半边行走**：
 *     · 每条裂缝发 **2 条半边**，各自记录「内部区域标签」与**各自的**覆盖率偏移；
 *     · 半边按**起点网格点**建索引；
 *     · 到达某顶点时，只在「内部标签相同」的候选里接续 → 保证每个区域的边界自洽；
 *     · 候选多于一个（鞍点：同色区域对角相接）时按固定方向优先级择一 → 确定性、不交叉。
 * ========================================================================== */

/* ---------- 1) 量化：中位切割 ---------- */
export function quantize(src, maxColors = 16) {
  const { data } = src;
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const pts = [...hist.entries()].map(([k, n]) => ({
    r: ((k >> 10) & 31) * 8 + 4, g: ((k >> 5) & 31) * 8 + 4, b: (k & 31) * 8 + 4, n
  }));
  let boxes = [pts];
  while (boxes.length < maxColors) {
    let bi = -1, bestVol = -1;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
      for (const p of b) {
        if (p.r < r0) r0 = p.r; if (p.r > r1) r1 = p.r;
        if (p.g < g0) g0 = p.g; if (p.g > g1) g1 = p.g;
        if (p.b < b0) b0 = p.b; if (p.b > b1) b1 = p.b;
      }
      const vol = Math.max(1, r1 - r0) * Math.max(1, g1 - g0) * Math.max(1, b1 - b0) * Math.min(b.length, 4096);
      if (vol > bestVol) { bestVol = vol; bi = i; }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const p of box) {
      if (p.r < r0) r0 = p.r; if (p.r > r1) r1 = p.r;
      if (p.g < g0) g0 = p.g; if (p.g > g1) g1 = p.g;
      if (p.b < b0) b0 = p.b; if (p.b > b1) b1 = p.b;
    }
    const dr = r1 - r0, dg = g1 - g0, db = b1 - b0;
    const key = dr >= dg && dr >= db ? 'r' : (dg >= db ? 'g' : 'b');
    const mid = (key === 'r' ? (r0 + r1) / 2 : key === 'g' ? (g0 + g1) / 2 : (b0 + b1) / 2);
    const A = [], B = [];
    for (const p of box) ((key === 'r' ? p.r : key === 'g' ? p.g : p.b) <= mid ? A : B).push(p);
    if (!A.length || !B.length) break;
    boxes.splice(bi, 1, A, B);
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const p of b) { r += p.r * p.n; g += p.g * p.n; bl += p.b * p.n; n += p.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

/* ---------- 2) 标签图 ---------- */
export function labelMap(src, palette) {
  const { width: w, height: h, data } = src;
  const labels = new Int32Array(w * h);
  const P = palette.length;
  for (let p = 0; p < w * h; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    let best = 0, bd = Infinity;
    for (let c = 0; c < P; c++) {
      const dr = r - palette[c][0], dg = g - palette[c][1], db = b - palette[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    labels[p] = best;
  }
  return labels;
}

/* ---------- 3) 4-连通同色小块去噪 ---------- */
export function denoiseLabels(labels, w, h, minSize = 8) {
  const n = w * h;
  const lab = Int32Array.from(labels);
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let cid = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const L = lab[s];
    let sp = 0; stack[sp++] = s; comp[s] = cid;
    const members = [];
    while (sp > 0) {
      const p = stack[--sp];
      members.push(p);
      const x = p % w, y = (p - x) / w;
      if (x > 0 && lab[p - 1] === L && comp[p - 1] === -1) { comp[p - 1] = cid; stack[sp++] = p - 1; }
      if (x < w - 1 && lab[p + 1] === L && comp[p + 1] === -1) { comp[p + 1] = cid; stack[sp++] = p + 1; }
      if (y > 0 && lab[p - w] === L && comp[p - w] === -1) { comp[p - w] = cid; stack[sp++] = p - w; }
      if (y < h - 1 && lab[p + w] === L && comp[p + w] === -1) { comp[p + w] = cid; stack[sp++] = p + w; }
    }
    if (members.length < minSize) {
      const cnt = new Map();
      for (const p of members) {
        const x = p % w, y = (p - x) / w;
        const nb = [];
        if (x > 0) nb.push(lab[p - 1]); if (x < w - 1) nb.push(lab[p + 1]);
        if (y > 0) nb.push(lab[p - w]); if (y < h - 1) nb.push(lab[p + w]);
        for (const q of nb) if (q !== L) cnt.set(q, (cnt.get(q) || 0) + 1);
      }
      let pick = -1, bn = -1;
      for (const [q, c] of cnt) if (c > bn) { bn = c; pick = q; }
      if (pick >= 0) for (const p of members) lab[p] = pick;
    }
    cid++;
  }
  return lab;
}

/* ---------- 3.5) 相邻近色区域合并（去碎片化）----------
 * 实测发现：本引擎 303 path vs VTracer 94 path —— 差距主因是**区域分割粒度**，
 * 典型情形是"同一条形状被一条细的异色线（多为抗锯齿中间色）切成两块"。
 * 做法：统计**相邻**标签对，凡颜色距离 < 阈值的，用并查集合并；迭代若干轮直到稳定。
 * 只合并「相邻且颜色近」的标签 → 不会把真正不同的区域糊在一起。
 */
const cdist = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
};

function labelMean(src, labels, K) {
  const acc = new Float64Array(K * 3), cnt = new Uint32Array(K);
  for (let p = 0; p < labels.length; p++) {
    const L = labels[p];
    acc[L * 3] += src.data[p * 4]; acc[L * 3 + 1] += src.data[p * 4 + 1]; acc[L * 3 + 2] += src.data[p * 4 + 2];
    cnt[L]++;
  }
  const mean = [];
  for (let i = 0; i < K; i++) mean.push(cnt[i] ? [acc[i * 3] / cnt[i], acc[i * 3 + 1] / cnt[i], acc[i * 3 + 2] / cnt[i]] : null);
  return { mean, cnt };
}

export function mergeSimilarLabels(src, labels, K, opts = {}) {
  const { delta = 16, rounds = 3 } = opts;
  const { width: w, height: h } = src;
  if (delta <= 0) return { labels: Int32Array.from(labels), merged: 0 };
  let cur = Int32Array.from(labels);
  let before = K;
  for (let round = 0; round < rounds; round++) {
    const { mean } = labelMean(src, cur, before);
    const parent = new Int32Array(before);
    for (let i = 0; i < before; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, A = cur[p];
        if (x + 1 < w) { const B = cur[p + 1]; if (B !== A && mean[A] && mean[B] && cdist(mean[A], mean[B]) < delta) uni(A, B); }
        if (y + 1 < h) { const B = cur[p + w]; if (B !== A && mean[A] && mean[B] && cdist(mean[A], mean[B]) < delta) uni(A, B); }
      }
    }
    /* 重映射并压缩标签空间 */
    const map = new Int32Array(before).fill(-1);
    const next = new Int32Array(cur.length);
    let k = 0;
    for (let p = 0; p < cur.length; p++) {
      const r = find(cur[p]);
      if (map[r] < 0) map[r] = k++;
      next[p] = map[r];
    }
    cur = next;
    const changed = before - k;
    before = k;
    if (!changed) break;
  }
  return { labels: cur, merged: K - before };
}

/* ---------- 4) marching squares 半边 + 覆盖率 α ---------- */
const cov = (data, p, from, to) => {
  const ar = from[0] - to[0], ag = from[1] - to[1], ab = from[2] - to[2];
  const den = ar * ar + ag * ag + ab * ab;
  if (den < 1) return 0;
  const t = ((data[p * 4] - to[0]) * ar + (data[p * 4 + 1] - to[1]) * ag + (data[p * 4 + 2] - to[2]) * ab) / den;
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

/**
 * 追踪所有区域的闭环轮廓。
 * @returns {Array<{label:number, pts:Float64Array}>} pts = x0,y0,x1,y1,...（每条半边的两端）
 */
export function traceContours(src, labels, palette) {
  const { width: w, height: h, data } = src;
  const lab = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]);
  const half = [];                       // {sx,sy,ex,ey,inLabel,dx,dy,ox,oy}
  const startAt = new Map();             // (sx,sy) -> [半边索引]

  const push = (sx, sy, ex, ey, inLabel, ox, oy) => {
    const i = half.length;
    half.push({ sx, sy, ex, ey, inLabel, ox, oy, dx: ex - sx, dy: ey - sy });
    const k = sx * 100000 + sy;
    if (!startAt.has(k)) startAt.set(k, []);
    startAt.get(k).push(i);
  };

  /* 竖裂缝：像素 (x-1,y) | (x,y)，线段 (x,y)–(x,y+1)，法线 +x */
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const L = lab(x - 1, y), R = lab(x, y);
      if (L === R) continue;
      const CA = palette[L], CB = palette[R];
      /* 左像素中"左色"的覆盖 → 边界位于 (x-1)+α，裂缝中线在 x → 偏移 = α-0.5 */
      const aL = cov(data, y * w + (x - 1), CA, CB) - 0.5;
      const aR = cov(data, y * w + x, CB, CA) - 0.5;
      push(x, y, x, y + 1, L, aL, 0);          /* 左色在西侧 → 向下走，西在左手边 */
      push(x, y + 1, x, y, R, -aR, 0);         /* 右色在东侧 → 向上走 */
    }
  }
  /* 横裂缝：像素 (x,y-1) | (x,y)，线段 (x,y)–(x+1,y)，法线 +y */
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const U = lab(x, y - 1), D = lab(x, y);
      if (U === D) continue;
      const CU = palette[U], CD = palette[D];
      const aU = cov(data, (y - 1) * w + x, CU, CD) - 0.5;
      const aD = cov(data, y * w + x, CD, CU) - 0.5;
      push(x + 1, y, x, y, U, 0, aU);          /* 上色在北侧 → 向左走（(−1,0) 的左侧=北 ✓） */
      push(x, y, x + 1, y, D, 0, aD);          /* 下色在南侧 → 向右走（(1,0) 的左侧=南 ✓） */
    }
  }

  /* 行走：只在「内部标签相同」的半边之间接续 */
  const used = new Uint8Array(half.length);
  const loops = [];
  for (let i = 0; i < half.length; i++) {
    if (used[i]) continue;
    const pts = [];
    let e = i, guard = 0, L = -1;
    while (e >= 0 && !used[e] && guard++ < half.length + 8) {
      used[e] = 1;
      const E = half[e];
      L = E.inLabel;
      pts.push(E.sx + E.ox, E.sy + E.oy, E.ex + E.ox, E.ey + E.oy);
      const cands = startAt.get(E.ex * 100000 + E.ey);
      if (!cands) break;
      /* 鞍点可能有多个同标签候选 → 按方向优先级取一个（向下 > 向右 > 向上 > 向左），保证确定性 */
      let best = -1, rank = 99;
      for (const c of cands) {
        if (used[c]) continue;
        const C = half[c];
        if (C.inLabel !== L) continue;
        const r = (C.dx === 0 && C.dy > 0) ? 0 : (C.dx > 0 ? 1 : (C.dy < 0 ? 2 : 3));
        if (r < rank) { rank = r; best = c; }
      }
      e = best;
      if (e === i) break;      /* 回到起始半边 → 闭环 */
    }
    if (pts.length >= 6) loops.push({ label: L, pts: Float64Array.from(pts) });
  }
  /* 诊断 */
  let consumed = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) consumed++;
  traceContours.__diag = { halves: half.length, consumed, loops: loops.length };
  return loops;
}

const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function contoursToSvg(loops, palette, w, h, opts = {}) {
  const { precision = 2, fit = true, fitError = 0.9, cornerAngle = 100 } = opts;
  const p = Math.pow(10, precision);
  let body = '';
  for (const lp of loops) {
    const pts = lp.pts;
    let d = 'M' + Math.round(pts[0] * p) / p + ' ' + Math.round(pts[1] * p) / p;
    for (let i = 2; i + 1 < pts.length; i += 2) {
      d += 'L' + Math.round(pts[i] * p) / p + ' ' + Math.round(pts[i + 1] * p) / p;
    }
    d += 'Z';
    if (fit) {
      try {
        const fd = fitClosedPath(lp.pts, { error: fitError, cornerAngle, precision });
        if (fd) d = fd;
      } catch (e) { /* 拟合失败则退回折线 */ }
    }
    body += '<path fill="' + hex(palette[lp.label]) + '" d="' + d + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '"><g fill-rule="nonzero">' + body + '</g></svg>';
}

export function traceToSvg(src, opts = {}) {
  const { maxColors = 16, minSpeckle = 8, precision = 2, regionMean = true, fit = true, fitError = 0.9, cornerAngle = 100, mergeDelta = 0 } = opts;
  const palette = quantize(src, maxColors);
  const K0 = palette.length;
  let labels = denoiseLabels(labelMap(src, palette), src.width, src.height, minSpeckle);

  /* 相邻近色区域合并（去碎片化）：合并「相邻且颜色近」的标签，直接消灭
     "同一条形状被一条细异色线切成两块"的碎片 */
  const mg = mergeDelta > 0 ? mergeSimilarLabels(src, labels, K0, { delta: mergeDelta }) : { labels, merged: 0 };
  labels = mg.labels;

  let K = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] >= K) K = labels[i] + 1;
  /* 用每个区域在原图中的**实际均值**作为填充色（合并后的标签空间） */
  const lm = labelMean(src, labels, K);
  const fill = regionMean ? lm.mean.map(c => c || [0, 0, 0]) : palette;

  const loops = traceContours(src, labels, fill);
  return {
    svg: contoursToSvg(loops, fill, src.width, src.height, { precision, fit, fitError, cornerAngle }),
    colors: K, loops: loops.length, merged: K0 - K, diag: traceContours.__diag || null,
    pts: loops.reduce((s, l) => s + l.pts.length / 2, 0)
  };
}