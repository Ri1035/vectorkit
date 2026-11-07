// B2：VTracer polygon SVG → RDP 简化 → 角点保护的手柄贝塞尔拟合
// 说明：这是交接书 B2 的“handle”路线（曲线严格通过简化后的锚点），
// 不是 Schneider 最小二乘拟合。用法:
//   node refit.mjs <polygon.svg> <out.svg> [rdpEps] [cornerAngle] [precision]
import fs from 'node:fs/promises';

const [inSvg, outSvg, epsStr = '0.35', angStr = '50', precStr = '2'] = process.argv.slice(2);
const EPS = +epsStr, CORNER = +angStr, PREC = +precStr;

const src = await fs.readFile(inSvg, 'utf8');
const width = (src.match(/<svg[^>]*\bwidth="([^"]+)"/) || [])[1] || '';
const height = (src.match(/<svg[^>]*\bheight="([^"]+)"/) || [])[1] || '';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = a => Math.hypot(a[0], a[1]);
const norm = a => { const l = len(a) || 1e-12; return [a[0] / l, a[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

function parseSubpaths(d) {
  const toks = d.match(/[MmLlZz]|[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || [];
  const subs = [];
  let cur = [], x = 0, y = 0, sx = 0, sy = 0, cmd = '';
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[MmLlZz]$/.test(t)) {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (cur.length >= 3) subs.push(cur);
        cur = [];
        x = sx; y = sy;
      }
      continue;
    }
    if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === 'M') {
      let nx = +toks[i], ny = +toks[i + 1]; i += 2;
      if (rel) { nx += x; ny += y; }
      if (cur.length >= 3) subs.push(cur);
      cur = [[nx, ny]];
      x = nx; y = ny; sx = nx; sy = ny;
      cmd = rel ? 'l' : 'L';
    } else if (c === 'L') {
      let nx = +toks[i], ny = +toks[i + 1]; i += 2;
      if (rel) { nx += x; ny += y; }
      cur.push([nx, ny]);
      x = nx; y = ny;
    } else {
      cur = [];
      i++;
    }
  }
  if (cur.length >= 3) subs.push(cur);
  return subs;
}

function distToLine(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return len(sub(p, a));
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return len(sub(p, q));
}

/* 对闭合环做 RDP：先找最远点对切成两条开链，分别简化后拼回 */
function rdpRing(pts, eps) {
  const n = pts.length;
  if (n < 4) return pts.slice();
  let ai = 0, bi = 0, best = -1;
  const step = n > 800 ? Math.ceil(n / 400) : 1;
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const d = len(sub(pts[i], pts[j]));
      if (d > best) { best = d; ai = i; bi = j; }
    }
  }
  const chainA = pts.slice(ai, bi + 1);
  const chainB = pts.slice(bi).concat(pts.slice(0, ai + 1));
  const keepA = rdpOpen(chainA, eps);
  const keepB = rdpOpen(chainB, eps);
  return keepA.concat(keepB.slice(1, -1));
}

function rdpOpen(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToLine(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > -1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const q = v => {
  const r = Math.round(v * Math.pow(10, PREC)) / Math.pow(10, PREC);
  return r;
};

/* 角点保护的手柄拟合：曲线严格通过锚点 */
function handlePath(pts) {
  const n = pts.length;
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = norm(sub(pts[i], pts[(i - 1 + n) % n]));
    const b = norm(sub(pts[(i + 1) % n], pts[i]));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
    if (ang > CORNER) corner[i] = 1;
  }
  const parts = ['M' + q(pts[0][0]) + ' ' + q(pts[0][1])];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = pts[i], p3 = pts[j];
    const l = len(sub(p3, p0)) / 3;
    const prev = pts[(i - 1 + n) % n], next = pts[(j + 1) % n];
    const outDir = corner[i] ? norm(sub(p3, p0)) : norm(sub(next, prev));
    const inDir = corner[j] ? norm(sub(p3, p0)) : norm(sub(next, prev));
    const c1 = [p0[0] + outDir[0] * l, p0[1] + outDir[1] * l];
    const c2 = [p3[0] - inDir[0] * l, p3[1] - inDir[1] * l];
    parts.push('C' + q(c1[0]) + ' ' + q(c1[1]) + ' ' + q(c2[0]) + ' ' + q(c2[1]) + ' ' + q(p3[0]) + ' ' + q(p3[1]));
  }
  parts.push('Z');
  return parts.join('');
}

let inPaths = 0, outPaths = 0, subCount = 0, dropped = 0;
let ptsIn = 0, ptsOut = 0;
const out = [];
const tagRe = /<path\b[^>]*>/g;
for (const m of src.matchAll(tagRe)) {
  inPaths++;
  const tag = m[0];
  const d = (tag.match(/\bd="([^"]+)"/) || [])[1];
  if (!d) { dropped++; continue; }
  const fill = (tag.match(/\bfill="([^"]+)"/) || [])[1] || '#000000';
  const fo = (tag.match(/\bfill-opacity="([^"]+)"/) || [])[1];
  for (let p of parseSubpaths(d)) {
    subCount++;
    ptsIn += p.length;
    if (p.length < 4) { dropped++; continue; }
    p = rdpRing(p, EPS);
    if (p.length < 4) p = parseSubpaths(d)[0] || p;
    if (p.length < 4) { dropped++; continue; }
    const nd = handlePath(p);
    if (!nd) { dropped++; continue; }
    ptsOut += p.length;
    out.push(`<path fill="${fill}"${fo ? ` fill-opacity="${fo}"` : ''} d="${nd}"/>`);
    outPaths++;
  }
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg version="1.1" xmlns="http://www.w3.org/2000/svg"` +
  `${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}` +
  `${width && height ? ` viewBox="0 0 ${width} ${height}"` : ''}>\n` +
  out.join('\n') + `\n</svg>\n`;
await fs.writeFile(outSvg, svg, 'utf8');
console.log(JSON.stringify({
  inPaths, subCount, outPaths, dropped, ptsIn, ptsOut,
  inBytes: Buffer.byteLength(src, 'utf8'),
  outBytes: Buffer.byteLength(svg, 'utf8'),
  curves: (svg.match(/C/g) || []).length,
  lines: (svg.match(/L/g) || []).length,
  rdpEps: EPS, cornerAngle: CORNER, precision: PREC
}));
