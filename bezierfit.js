/* ============================================================================
 * 曲线拟合（v6.2 · 并列引擎 P1）
 *
 * 目的：把 P0 输出的**像素阶梯折线**换成**尽可能少的三次贝塞尔**。
 * 依据：VectorCraft（storytold/vectorcraft，crates/trace/fit.rs）的做法 ——
 *   还原被模糊磨圆的角点 → 直段成线 → 圆轮廓成正圆 → 其余用容差允许的最少三次贝塞尔。
 *
 * 算法：Schneider 的最小平方三次贝塞尔拟合（含牛顿-拉夫森重参数化 + 递归二分），
 * 并在此基础上加**角点保护**：转角超过阈值的点强制成为拟合断点，不允许曲线穿过。
 * ========================================================================== */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = a => Math.hypot(a[0], a[1]);
const norm = a => { const l = len(a) || 1e-12; return [a[0] / l, a[1] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist2 = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
};
const bez = (p0, p1, p2, p3, t) => {
  const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
};
const bezD = (p0, p1, p2, p3, t) => {
  const mt = 1 - t, a = 3 * mt * mt, b = 6 * mt * t, c = 3 * t * t;
  return [a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
          a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1])];
};
const bezD2 = (p0, p1, p2, p3, t) => {
  const mt = 1 - t;
  return [6 * mt * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
          6 * mt * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1])];
};

function chordParameterize(pts, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= total;
  return u;
}

function generateBezier(pts, first, last, u, tan1, tan2) {
  const n = last - first + 1;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  const p0 = pts[first], p3 = pts[last];
  const tmp = sub(mul(p0, 3), mul(p3, 3));
  for (let i = 0; i < n; i++) {
    const uu = u[i], t = 1 - uu;
    c00 += uu * t * t * t;
    c01 += 3 * uu * uu * t * t;
    c11 += 3 * uu * t * t * t;
    const base = add(add(mul(p0, t * t * t * 3), mul(p3, uu * uu * u * 3)), mul(tan1, uu * uu * t * 3));
    x0 += c00 * base[0];
    x1 += c01 * base[0];
  }
  /* 通用最小二乘（同时解 c1/c2） */
  let a00 = c00 * c00, a01 = c00 * c01, a11 = c01 * c01;
  let b0 = 0, b1 = 0;
  for (let i = 0; i < n; i++) {
    const uu = u[i], t = 1 - uu;
    const mt3u = t * t * t * uu, mu3t2 = uu * uu * t * t;
    const base = add(add(mul(p0, t * t * t * 3), mul(p3, uu * uu * uu * 3)),
      add(mul(tan1, mu3t2), mul(tan2, mt3u)));
    const r = sub(pts[first + i], base);
    b0 += c00 * r[0]; b1 += c01 * r[0];
  }
  const det = a00 * a11 - a01 * a01;
  const alphaL = Math.abs(det) < 1e-12 ? 0 : (b0 * a11 - b1 * a01) / det;
  const alphaR = Math.abs(det) < 1e-12 ? 0 : (a00 * b1 - a01 * b0) / det;
  let c1 = add(p0, mul(tan1, alphaL));
  let c2 = add(p3, mul(tan2, alphaR));
  /* 端点退化保护 */
  const d1 = len(sub(c1, p0)), d2 = len(sub(c2, p3));
  const seg = len(sub(p3, p0)) / 3;
  if (d1 < 1e-6) c1 = add(p0, mul(tan1, seg));
  if (d2 < 1e-6) c2 = add(p3, mul(tan2, seg));
  void tmp; void x0; void x1;
  return [c1, c2];
}

function computeMaxError(pts, first, last, u, bezr) {
  let idx = first, max = 0;
  for (let i = first + 1; i < last; i++) {
    const q = bez(pts[first], bezr[0], bezr[1], pts[last], u[i - first]);
    const dd = (pts[i][0] - q[0]) ** 2 + (pts[i][1] - q[1]) ** 2;
    if (dd >= max) { max = dd; idx = i; }
  }
  return { max: Math.sqrt(max), idx };
}

function newtonRaphson(pts, first, last, u, bezr) {
  for (let k = 0; k < 8; k++) {
    let moved = 0;
    for (let i = first; i <= last; i++) {
      const uu = u[i - first];
      const q = bez(pts[first], bezr[0], bezr[1], pts[last], uu);
      const q1 = bezD(pts[first], bezr[0], bezr[1], pts[last], uu);
      const q2 = bezD2(pts[first], bezr[0], bezr[1], pts[last], uu);
      const num = (pts[i][0] - q[0]) * q1[0] + (pts[i][1] - q[1]) * q1[1];
      const den = q1[0] * q1[0] + q1[1] * q1[1] + (pts[i][0] - q[0]) * q2[0] + (pts[i][1] - q[1]) * q2[1];
      if (Math.abs(den) < 1e-12) continue;
      const d = num / den;
      const nu = Math.max(0, Math.min(1, uu - d));
      moved = Math.max(moved, Math.abs(nu - uu));
      u[i - first] = nu;
    }
    if (moved < 1e-6) break;
  }
}

function fit(pts, first, last, err, out) {
  if (last - first < 2) { out.push({ line: true, p0: pts[first], p1: pts[last] }); return; }
  const u = chordParameterize(pts, first, last);
  const tan1 = norm(sub(pts[Math.min(first + 1, last)], pts[first]));
  const tan2 = norm(sub(pts[Math.max(last - 1, first)], pts[last]));
  let bezr = generateBezier(pts, first, last, u, tan1, tan2);
  let { max, idx } = computeMaxError(pts, first, last, u, bezr);
  if (max < err) { out.push({ p0: pts[first], c1: bezr[0], c2: bezr[1], p3: pts[last] }); return; }
  for (let it = 0; it < 6 && max >= err; it++) {
    newtonRaphson(pts, first, last, u, bezr);
    const r = computeMaxError(pts, first, last, u, bezr);
    if (r.max < max) { max = r.max; idx = r.idx; } else break;
  }
  if (max < err) { out.push({ p0: pts[first], c1: bezr[0], c2: bezr[1], p3: pts[last] }); return; }
  if (idx <= first) idx = first + 1;
  if (idx >= last) idx = last - 1;
  fit(pts, first, idx, err, out);
  fit(pts, idx, last, err, out);
}

/**
 * 把闭合折线拟合为贝塞尔路径。
 * @param {number[]} flat x0,y0,x1,y1,...（闭合，不含重复末点）
 * @param {{error?:number, cornerAngle?:number, precision?:number}} opts
 * @returns {string} SVG path 的 d
 */
export function fitClosedPath(flat, opts = {}) {
  const { error = 0.9, cornerAngle = 100, precision = 2 } = opts;
  const n = flat.length / 2;
  if (n < 3) return '';
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([flat[i * 2], flat[i * 2 + 1]]);
  /* 去掉近重复点（相邻距离 < 0.35px 视为同一角点） */
  const cl = [];
  for (const p of pts) {
    if (!cl.length || len(sub(p, cl[cl.length - 1])) > 0.35) cl.push(p);
  }
  if (cl.length >= 2 && len(sub(cl[0], cl[cl.length - 1])) <= 0.35) cl.pop();
  if (cl.length < 3) return '';

  /* 角点：转角 > cornerAngle → 强制断点 */
  const corner = new Set([0]);
  for (let i = 1; i < cl.length - 1; i++) {
    const a = norm(sub(cl[i], cl[i - 1])), b = norm(sub(cl[i + 1], cl[i]));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
    if (ang > cornerAngle) corner.add(i);
  }
  corner.add(cl.length);          /* 终点 = 起点 */

  const segs = [];
  const bounds = [...corner].sort((a, b) => a - b);
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k], b = bounds[k + 1];
    if (b - a < 1) continue;
    const slice = cl.slice(a, b + 1);
    if (slice.length === 2) { segs.push({ line: true, p0: slice[0], p1: slice[1] }); continue; }
    const tmp = [];
    fit(slice, 0, slice.length - 1, error, tmp);
    for (const sgm of tmp) segs.push(sgm);
  }

  const q = v => { const r = Math.round(v * Math.pow(10, precision)) / Math.pow(10, precision); return r; };
  let d = 'M' + q(cl[0][0]) + ' ' + q(cl[0][1]);
  let cur = cl[0];
  for (const sgm of segs) {
    if (sgm.line) {
      if (len(sub(sgm.p0, cur)) > 1e-9) d += 'L' + q(sgm.p0[0]) + ' ' + q(sgm.p0[1]);
      cur = sgm.p1;
    } else {
      d += 'C' + q(sgm.c1[0]) + ' ' + q(sgm.c1[1]) + ' ' + q(sgm.c2[0]) + ' ' + q(sgm.c2[1]) + ' ' + q(sgm.p3[0]) + ' ' + q(sgm.p3[1]);
      cur = sgm.p3;
    }
  }
  d += 'Z';
  return d;
}

/** 统计一段 d 里的命令数（用于回归对比） */
export function countSegs(d) {
  return { c: (d.match(/C/g) || []).length, l: (d.match(/L/g) || []).length };
}