/* ============================================================================
 * 并列描摹引擎 · P0 原型（v5.9）
 * 机制参照 storytold/vectorcraft 的 crates/trace/（Apache-2.0）
 *
 * 管线：量化 → 标签图 → 4连通去噪 → 裂缝提取 → **覆盖率 α 重定位** → 闭环 → 折线 SVG
 *
 * P0 的意义：折线版节点数≈边界像素数（很大），但它代表**纯几何阶段的上限**。
 * 若它能超过现有最佳（34.49 dB），则机制有效，剩余工作只是"用更少节点达到同样精度"的拟合问题；
 * 若打不过，说明机制在我们的场景无效 → 立即止损。
 * ========================================================================== */
/* ============================================================================
 * ⚠️⚠️ **状态：未达标 / 未接入** —— 请勿在产品中启用 ⚠️⚠️
 *
 * 实测（bc.png 1024²）：PSNR 14.61 dB（基线 VTracer 34.49 dB），**远未达 M1 门槛 35.5 dB**。
 * 已定位到的**根因（4 轮）**：
 *   1. 填充色误用外部标签；
 *   2. 闭环 break 判断落在首轮迭代 → 0 条轮廓；
 *   3. **裂缝只发了"内部在左/上"一侧的有向边** → 右侧/下侧区域的边界**无法被遍历**，
 *      walk 只能跳到无关边 → 图上出现对角三角形；
 *   4. 改为"每条裂缝双侧发边"后环数暴增（158 环 / 9.06 dB）—— 说明 **ad-hoc 裂缝行走在
 *      多标签场景下从设计上就不可靠**。
 *
 * **正确结论**：多标签轮廓必须用**带 16 例连接表的 marching squares**（按每个 2×2 单元的
 * 标签配置显式决定段的连接），而不是"裂缝 + 转角偏好"的启发式行走。那是**重写**而非打补丁。
 * 本文件保留作为**研究记录与踩坑档案**，未被 app.js 引用，不影响任何默认路径。
 * ========================================================================== */

/* ---------- 1) 量化：中位切割（中位切分 + 最近色归属） ---------- */
export function quantize(src, maxColors = 16) {
  const { width: w, height: h, data } = src;
  /* 15bit 直方图 */
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
    /* 选体积最大且可分的盒子切分 */
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
    if (!A.length || !B.length) { boxes.splice(bi, 1); boxes.push(box); break; }
    boxes.splice(bi, 1, A, B);
  }
  /* 盒子均值作代表色 */
  const palette = boxes.map(b => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const p of b) { r += p.r * p.n; g += p.g * p.n; bl += p.b * p.n; n += p.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
  return palette;
}

/** 标签图：每个像素归到最近的代表色 */
export function labelMap(src, palette) {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const labels = new Int32Array(n);
  const P = palette.length;
  for (let p = 0; p < n; p++) {
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

/* ---------- 2) 4-连通同色小块去噪：小于 minSize 的并入最常见邻色 ---------- */
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
      /* 统计邻居色频次，取最多者 */
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

/* ---------- 3) 裂缝 + 覆盖率 α + 闭环 ---------- */
/** 覆盖率：像素 (px,py) 中颜色 CA 的占比（CA/CB 为两侧区域色） */
function coverage(r, g, b, CA, CB) {
  const ar = CA[0] - CB[0], ag = CA[1] - CB[1], ab = CA[2] - CB[2];
  const den = ar * ar + ag * ag + ab * ab;
  if (den < 1) return 0.5;
  const t = ((r - CB[0]) * ar + (g - CB[1]) * ag + (b - CB[2]) * ab) / den;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

const key = (x, y) => x * 100000 + y;

/**
 * 追踪闭环轮廓（内部在行进方向左侧）。
 * @returns {Array<{label:number, pts:Float64Array}>} 每条：内部标签 + 亚像素顶点
 */
export function traceContours(src, labels, palette) {
  const { width: w, height: h, data } = src;
  const startMap = new Map();      // 起点 -> 边索引数组（鞍点可能有多条出边）
  const edges = [];                // {x0,y0,x1,y1,inLabel,nx,ny,ox,oy}
  /** 一条裂缝的两侧各发一条有向边（内部各为一侧）——
      否则"右侧/下侧区域"的边界无法被遍历（v5.9 首版 bug：图上出现对角三角形） */
  const addCrack = (x0, y0, x1, y1, pa, pb) => {
    const la = labels[pa], lb = labels[pb];
    if (la === lb) return;
    const CA = palette[la], CB = palette[lb];
    const cov = (p, from, to) => {
      const a = coverage(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], from, to);
      return a - 0.5;                            // 裂缝在像素中线，偏移 = α - 0.5
    };
    /* pa 侧：内部在 (dx,dy) 的反方向 → 偏移沿 +n */
    let oa = cov(pa, CA, CB), ob = cov(pb, CB, CA);
    const dx = x1 - x0, dy = y1 - y0;
    const nx = dy, ny = -dx;                      // 法线（指向 pa 一侧）
    const s = (nx * (pa % w - pb % w) + ny * (((pa - pa % w) / w) - ((pb - pb % w) / w))) > 0 ? 1 : -1;
    edges.push({ x0, y0, x1, y1, inLabel: la, ox: nx * oa * s, oy: ny * oa * s });
    if (!startMap.has(key(x0, y0))) startMap.set(key(x0, y0), []);
    startMap.get(key(x0, y0)).push(edges.length - 1);
    /* pb 侧：反向 */
    edges.push({ x0: x1, y0: y1, x1: x0, y1: y0, inLabel: lb, ox: nx * ob * s, oy: ny * ob * s });
    if (!startMap.has(key(x1, y1))) startMap.set(key(x1, y1), []);
    startMap.get(key(x1, y1)).push(edges.length - 1);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const L = labels[p];
      if (x + 1 < w) addCrack(x + 1, y, x + 1, y + 1, p, p + 1);
      if (y + 1 < h) addCrack(x + 1, y + 1, x, y + 1, p, p + w);
    }
  }
  /* 连成闭环 */
  const used = new Uint8Array(edges.length);
  const loops = [];
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // 屏幕坐标(y向下)：索引递增 = 右转
  const dirIdx = (dx, dy) => DIRS.findIndex(d => d[0] === dx && d[1] === dy);
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const pts = [];
    let e = i, guard = 0;
    let inLabel = -1;
    while (e >= 0 && !used[e] && guard++ < edges.length + 8) {
      used[e] = 1;
      const E = edges[e];
      inLabel = E.inLabel;
      pts.push(E.x0 + E.ox, E.y0 + E.oy, E.x1 + E.ox, E.y1 + E.oy);
      const cands = startMap.get(key(E.x1, E.y1));
      if (!cands || !cands.length) break;
      const inD = dirIdx(E.x1 - E.x0, E.y1 - E.y0);
      let best = -1, bestTurn = 99;
      for (const c of cands) {
        if (used[c]) continue;
        const C = edges[c];
        const t = ((dirIdx(C.x1 - C.x0, C.y1 - C.y0) - inD) + 4) % 4;
        /* 内部在左（left = (-dy,dx)，即索引 +1）→ 优先左转 t=1，再直行，再次左，最后右 */
        const rank = t === 1 ? 0 : t === 0 ? 1 : t === 2 ? 2 : 3;
        if (rank < bestTurn) { bestTurn = rank; best = c; }
      }
      e = best;
      if (e === i) break;          /* 回到起始边 → 闭环 */
    }
    if (pts.length >= 6) loops.push({ label: inLabel, pts: Float64Array.from(pts) });
  }
  return loops;
}

const hex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** 折线 SVG（P0：不做曲线拟合，用于测"纯几何阶段的上限"） */
export function contoursToSvg(loops, palette, w, h, opts = {}) {
  const { precision = 2 } = opts;
  const p = Math.pow(10, precision);
  let body = '';
  for (const lp of loops) {
    const pts = lp.pts;
    let d = 'M' + Math.round(pts[0] * p) / p + ' ' + Math.round(pts[1] * p) / p;
    for (let i = 2; i + 1 < pts.length; i += 2) {
      d += 'L' + Math.round(pts[i] * p) / p + ' ' + Math.round(pts[i + 1] * p) / p;
    }
    d += 'Z';
    body += '<path fill="' + hex(palette[lp.label]) + '" d="' + d + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '"><g fill-rule="nonzero">' + body + '</g></svg>';
}

/** 一步到位 */
export function traceToSvg(src, opts = {}) {
  const { maxColors = 16, minSpeckle = 8, precision = 2 } = opts;
  const palette = quantize(src, maxColors);
  const labels0 = labelMap(src, palette);
  const labels = denoiseLabels(labels0, src.width, src.height, minSpeckle);
  const loops = traceContours(src, labels, palette);
  return {
    svg: contoursToSvg(loops, palette, src.width, src.height, { precision }),
    colors: palette.length, loops: loops.length,
    pts: loops.reduce((s, l) => s + l.pts.length / 2, 0)
  };
}