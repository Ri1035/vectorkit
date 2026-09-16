/* ============================================================
 * 同色闭合路径合并（几何布尔并集）+ 锚点简化
 *
 * 复刻 Inkscape「选中同色闭合路径 → Union」流程，用于解决
 * CorelDRAW X4 等软件导入 VTracer 输出后成千上万色块导致的卡顿。
 *
 * 与 SVGO mergePaths 的本质区别：
 *   - SVGO mergePaths 只是把多个 <path> 的 d 字符串拼在一起（对象数不变）
 *   - 本模块用 Paper.js 做**真实几何布尔并集**，重叠区域按布尔运算合并，
 *     输出单一路径，图形对象数真正减少
 *
 * 简化部分的实现说明（重要）：
 *   Paper.js 的 Path.simplify() 是**曲线拟合**（把折线拟合成贝塞尔），
 *   实测会把直边画成曲边（面积偏差可达 50%+），不适合印刷硬边图形。
 *   因此这里改用零变形的两条策略：
 *     1. 纯直线子路径 → Douglas-Peucker（保证与原始路径偏差 ≤ tolerance）
 *     2. 含曲线子路径 → 仅移除重复点与共线冗余点（不动曲线段）
 *
 * 安全边界：
 *   - 只处理闭合且填充为纯色的路径；开放线条 / 描边轮廓不合并
 *   - fill:none、渐变、pattern 填充不参与
 *   - 位于 defs / clipPath / mask / pattern / symbol / marker 内的元素不参与
 *   - 自身带 clip-path / mask 的元素不参与
 *   - text / image / use 等元素完全不经 Paper.js，原样保留
 * ============================================================ */

import { absolutizePath } from './svg-compat.js';
import { arcToCubics } from './eps-export.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon']);
const HIDDEN_CONTAINERS = new Set(['defs', 'clippath', 'mask', 'pattern', 'symbol', 'marker']);

/* ============================ 仿射矩阵 ============================ */

const ID = [1, 0, 0, 1, 0, 0];

function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

const applyM = (m, x, y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
];

/** 2×3 仿射矩阵求逆（用于抵消祖先 transform） */
function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id
  ];
}

const isIdentityM = m =>
  Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 &&
  Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 &&
  Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;

function parseTransformStr(str) {
  let m = ID;
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str)) !== null) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let cur = ID;
    switch (t[1]) {
      case 'matrix': if (a.length >= 6) cur = a.slice(0, 6); break;
      case 'translate': cur = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': cur = [a[0] || 1, 0, 0, a.length > 1 ? a[1] : (a[0] || 1), 0, 0]; break;
      case 'rotate': {
        const r = (a[0] || 0) * Math.PI / 180;
        const c = Math.cos(r), s = Math.sin(r);
        const rot = [c, s, -s, c, 0, 0];
        cur = a.length >= 3
          ? matMul(matMul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]])
          : rot;
        break;
      }
      case 'skewX': cur = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break;
      case 'skewY': cur = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = matMul(m, cur);
  }
  return m;
}

/* ============================ 样式解析 ============================ */

function parseDecls(str) {
  const map = {};
  if (!str) return map;
  str.split(';').forEach(p => {
    const i = p.indexOf(':');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k && v) map[k] = v;
  });
  return map;
}

/**
 * 收集 <style> 中的全部规则（保留选择器原文，不限简单类选择器）。
 * 用 el.matches() 在原文档里求匹配，因此 #id / 后代 / 属性选择器也能正确解析——
 * 若只支持 `.class`，被忽略的规则会让元素退回默认黑，导致颜色分组错误、
 * 进而把不同颜色的图形错误合并（并因保留 id 让 CSS 继续覆盖，产生视觉破坏）。
 */
function collectStyleRules(doc) {
  const list = [];
  doc.querySelectorAll('style').forEach(node => {
    const txt = node.textContent || '';
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const decls = parseDecls(m[2]);
      if (!Object.keys(decls).length) continue;
      m[1].split(',').forEach(s => {
        const sel = s.trim();
        if (sel) list.push({ sel, decls });
      });
    }
  });
  return list;
}

const cssCache = new WeakMap();
function cssDecls(el, rules) {
  if (!rules.length) return EMPTY_DECLS;
  let per = cssCache.get(el);
  if (per && per.rules === rules) return per.value;
  let out = {};
  for (const r of rules) {                 // 按出现顺序，后者覆盖前者（近似 CSS 层叠）
    try {
      if (el.matches(r.sel)) out = Object.assign(out, r.decls);
    } catch (e) { /* 不支持的伪类等选择器，忽略 */ }
  }
  cssCache.set(el, { rules, value: out });
  return out;
}

const EMPTY_DECLS = {};

/**
 * 取属性值，优先级：inline style > <style> 规则 > presentation attribute > 继承
 */
function pickProp(el, prop, inherited, rules) {
  const inline = parseDecls(el.getAttribute('style'))[prop];
  if (inline !== undefined && inline !== '') return inline;
  const fromCss = cssDecls(el, rules)[prop];
  if (fromCss !== undefined && fromCss !== '') return fromCss;
  if (el.hasAttribute(prop)) return el.getAttribute(prop);
  return inherited;
}

/* ============================ 颜色 ============================ */

const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  orange: [255, 165, 0], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128],
  maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
  fuchsia: [255, 0, 255], gold: [255, 215, 0], pink: [255, 192, 203],
  brown: [165, 42, 42], beige: [245, 245, 220], ivory: [255, 255, 240]
};

/** 解析颜色 → {kind:'rgb'|'none'|'ref'|'unknown'|'inherit', rgb?, raw} */
function parsePaint(v) {
  if (v === undefined || v === null || v === '') return { kind: 'inherit' };
  const s = String(v).trim();
  if (s === 'none' || s === 'transparent') return { kind: 'none' };
  if (s === 'inherit' || s === 'currentColor' || s.startsWith('context-')) return { kind: 'inherit' };
  if (/^url\(/.test(s)) return { kind: 'ref', raw: s };

  if (s[0] === '#') {
    const h = s.slice(1);
    const full = (h.length === 3 || h.length === 4) ? h.split('').map(c => c + c).join('') : h;
    if (full.length >= 6) {
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      if (![r, g, b].some(isNaN)) return { kind: 'rgb', rgb: [r, g, b] };
    }
    return { kind: 'unknown', raw: s };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const val = x => x.endsWith('%') ? Math.round(parseFloat(x) * 2.55) : parseFloat(x);
      const [r, g, b] = parts.slice(0, 3).map(val);
      if (![r, g, b].some(isNaN)) return { kind: 'rgb', rgb: [r, g, b] };
    }
    return { kind: 'unknown', raw: s };
  }
  if (NAMED[s]) return { kind: 'rgb', rgb: NAMED[s] };
  return { kind: 'unknown', raw: s };
}

const toHex = ([r, g, b]) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/* ============================ 形状 → path d ============================ */

const KAPPA = 0.5522847498307936;

function shapeToD(el) {
  const tag = el.tagName.toLowerCase();
  const num = (n, def = 0) => {
    const v = parseFloat(el.getAttribute(n));
    return isNaN(v) ? def : v;
  };

  if (tag === 'path') return el.getAttribute('d') || '';

  if (tag === 'rect') {
    const x = num('x'), y = num('y'), w = num('width'), h = num('height');
    if (w <= 0 || h <= 0) return '';
    let rx = num('rx', NaN), ry = num('ry', NaN);
    if (isNaN(rx) && isNaN(ry)) { rx = ry = 0; }
    else if (isNaN(rx)) rx = ry;
    else if (isNaN(ry)) ry = rx;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    if (rx <= 0 || ry <= 0) {
      return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    }
    const k = 1 - KAPPA;
    return [
      `M ${x + rx} ${y}`,
      `H ${x + w - rx}`,
      `C ${x + w - rx * k} ${y} ${x + w} ${y + ry - ry * k} ${x + w} ${y + ry}`,
      `V ${y + h - ry}`,
      `C ${x + w} ${y + h - ry + ry * k} ${x + w - rx + rx * k} ${y + h} ${x + w - rx} ${y + h}`,
      `H ${x + rx}`,
      `C ${x + rx - rx * k} ${y + h} ${x} ${y + h - ry + ry * k} ${x} ${y + h - ry}`,
      `V ${y + ry}`,
      `C ${x} ${y + ry - ry * k} ${x + rx - rx * k} ${y} ${x + rx} ${y}`,
      'Z'
    ].join(' ');
  }

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = num('cx'), cy = num('cy');
    const rx = tag === 'circle' ? num('r') : num('rx');
    const ry = tag === 'circle' ? num('r') : num('ry');
    if (rx <= 0 || ry <= 0) return '';
    const kx = rx * KAPPA, ky = ry * KAPPA;
    return [
      `M ${cx + rx} ${cy}`,
      `C ${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}`,
      `C ${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}`,
      `C ${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}`,
      `C ${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}`,
      'Z'
    ].join(' ');
  }

  if (tag === 'polygon') {
    const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (pts.length < 6) return '';
    const seg = [`M ${pts[0]} ${pts[1]}`];
    for (let i = 2; i + 1 < pts.length; i += 2) seg.push(`L ${pts[i]} ${pts[i + 1]}`);
    seg.push('Z');
    return seg.join(' ');
  }

  return '';
}

/**
 * 判断路径是否几何闭合。
 * 注意：VTracer 等描摹工具输出的闭合轮廓通常**不带 Z 命令**，
 * 而是用「终点回到起点」的方式闭合（填充时 SVG 隐式闭合），
 * 所以不能只按 Z 判定，否则真实矢量化结果会被整批跳过。
 */
export function isClosedPath(d, tol = 1.0) {
  if (/[Zz]/.test(d)) return true;
  const abs = absolutizePath(d);
  const nums = abs.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!nums || nums.length < 6) return false;
  const x0 = parseFloat(nums[0]), y0 = parseFloat(nums[1]);
  const xn = parseFloat(nums[nums.length - 2]);
  const yn = parseFloat(nums[nums.length - 1]);
  if (![x0, y0, xn, yn].every(isFinite)) return false;
  return Math.hypot(xn - x0, yn - y0) <= tol;
}

/**
 * 把 path 的 d 转成「绝对命令 + 已应用 CTM」的扁平 d。
 * 圆弧 A 与二次贝塞尔 Q 统一转为三次贝塞尔 C，规避弧在有旋转/非等比缩放下的变换难题。
 */
export function flattenToAbsoluteD(d, m) {
  const abs = absolutizePath(d);
  const re = /([MLCQAZ])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  const tokens = [];
  let tk;
  while ((tk = re.exec(abs)) !== null) tokens.push(tk[0]);
  if (!tokens.length) return '';

  const f = v => String(Math.round(v * 1000) / 1000);
  const T = (x, y) => applyM(m, x, y);
  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const n = () => parseFloat(tokens[i++]);

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) { i++; continue; }

    switch (cmd) {
      case 'M': {
        const x = n(), y = n();
        const p = T(x, y);
        out.push(`M ${f(p[0])} ${f(p[1])}`);
        cx = x; cy = y; sx = x; sy = y;
        while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) {
          const lx = n(), ly = n();
          const q = T(lx, ly);
          out.push(`L ${f(q[0])} ${f(q[1])}`);
          cx = lx; cy = ly;
        }
        break;
      }
      case 'L': {
        const x = n(), y = n();
        const p = T(x, y);
        out.push(`L ${f(p[0])} ${f(p[1])}`);
        cx = x; cy = y;
        break;
      }
      case 'C': {
        const x1 = n(), y1 = n(), x2 = n(), y2 = n(), ex = n(), ey = n();
        const a = T(x1, y1), b = T(x2, y2), e = T(ex, ey);
        out.push(`C ${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])} ${f(e[0])} ${f(e[1])}`);
        cx = ex; cy = ey;          // 必须更新当前点：后续 Q/A 的控制点依赖它
        break;
      }
      case 'Q': {
        const qx = n(), qy = n(), ex = n(), ey = n();
        const c1 = T(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy));
        const c2 = T(ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey));
        const e = T(ex, ey);
        out.push(`C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(e[0])} ${f(e[1])}`);
        cx = ex; cy = ey;
        break;
      }
      case 'A': {
        const rx = n(), ry = n(), rot = n(), laf = n(), sf = n();
        const ax = n(), ay = n();
        const segs = arcToCubics(cx, cy, rx, ry, rot, laf, sf, ax, ay);
        for (const s of segs) {
          const c1 = T(s[0], s[1]), c2 = T(s[2], s[3]), e = T(s[4], s[5]);
          out.push(`C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(e[0])} ${f(e[1])}`);
        }
        cx = ax; cy = ay;
        break;
      }
      case 'Z': {
        out.push('Z');
        cx = sx; cy = sy;
        break;
      }
      default:
        i++;
    }
  }
  return out.join(' ');
}

/* ============================ 锚点简化（零变形） ============================ */

/** 点到线段的距离 */
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas-Peucker：返回应保留的点索引（含首尾）。
 * 与原始点列偏差上界 = tol，不引入曲线，形状不会「过度简化变形」。
 */
function dpKeep(points, tol) {
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  if (n <= 2) return keep;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxD = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(points[k], points[i], points[j]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tol && idx > i) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return keep;
}

/** 闭合环选择两个基准点（尽量远），把环拆成两段做 D-P */
function ringAnchors(points) {
  const n = points.length;
  if (n < 4) return [0, 1];
  if (n > 800) return [0, n >> 1];
  let best = -1, a = 0, b = 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2;
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  return a < b ? [a, b] : [b, a];
}

/* ============================ Paper.js 加载 ============================ */

let paperPromise = null;

async function loadPaper() {
  if (window.paper) return window.paper;
  if (paperPromise) return paperPromise;
  paperPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/paper-full.min.js', import.meta.url).href;
    s.onload = () => {
      if (!window.paper) { reject(new Error('Paper.js 未挂载到全局')); return; }
      try { window.paper.setup(document.createElement('canvas')); } catch (e) { /* 已有项目上下文 */ }
      resolve(window.paper);
    };
    s.onerror = () => { paperPromise = null; reject(new Error('Paper.js 加载失败')); };
    document.head.appendChild(s);
  });
  return paperPromise;
}

/* ============================ 主流程 ============================ */

/**
 * 两两配对归并（分治）求并集。
 * 线性累积 unite 会让每次调用的输入路径越来越大，总成本接近 O(n²)；
 * 分治每层的总输入规模是 O(n)，实测在数千色块场景下快约一个数量级。
 */
function uniteBalanced(items) {
  if (items.length === 1) return items[0];
  let level = items;
  let guard = 0;
  while (level.length > 1 && guard++ < 40) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) { next.push(level[i]); continue; }
      let r = null;
      try { r = level[i].unite(level[i + 1], { insert: false }); } catch (e) { /* 保留左项 */ }
      next.push(r || level[i]);
    }
    level = next;
  }
  return level[0];
}

/**
 * 合并同色闭合路径
 * @param {string} svgText
 * @param {Object} opts
 * @param {number} opts.tolerance 锚点简化容差（px），推荐 0.02–0.1
 * @param {(p:number, label:string)=>void} opts.onProgress
 * @returns {Promise<{svg:string, stats:Object|null, warnings:string[]}>}
 */
export async function mergeSameColorPaths(svgText, opts = {}) {
  const { tolerance = 0.05, onProgress } = opts;
  const warnings = [];
  const t0 = performance.now();

  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch (e) {
    return { svg: svgText, stats: null, warnings: ['SVG 解析失败，已跳过同色合并'] };
  }
  if (doc.querySelector('parsererror')) {
    return { svg: svgText, stats: null, warnings: ['SVG 解析失败，已跳过同色合并'] };
  }

  const root = doc.documentElement;
  const rules = collectStyleRules(doc);

  /* ---------- 遍历：收集候选路径 + 全部颜色 ---------- */
  const candidates = [];        // { el, d, key(css颜色), ctm }
  const colorSet = new Set();
  const skipped = {
    gradient: 0,      // 渐变 / 图案填充
    open: 0,          // 开放线条、无填充
    hidden: 0,        // 位于 defs/clipPath/mask/… 内
    masked: 0,        // 自身带 clip-path / mask
    semiTransparent: 0,
    unknownStyle: 0,  // 含 <style> 但填充色来源不明
    nestedSvg: 0,
    nonRgb: 0,
    image: 0,
    other: 0
  };
  const statsCollect = { shapes: 0, strokes: 0 };

  const inHidden = el => {
    let p = el.parentElement;
    while (p && p !== root.parentElement) {
      if (HIDDEN_CONTAINERS.has(p.tagName.toLowerCase())) return true;
      p = p.parentElement;
    }
    return false;
  };

  const collectColor = paint => {
    if (paint.kind === 'rgb') colorSet.add(toHex(paint.rgb));
    else if (paint.kind === 'unknown') { colorSet.add(String(paint.raw).slice(0, 24)); skipped.nonRgb++; }
  };

  function walk(nodes, pCtm, pStyle) {
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'defs' || tag === 'style' || tag === 'metadata' || tag === 'title' || tag === 'desc') continue;

      if (tag === 'image' || tag === 'foreignobject') { skipped.image++; continue; }

      /* 内嵌 <svg> 自带 viewBox / x / y / width / height，坐标语义与 <g> 不同，
         保守跳过其内容而不是按 <g> 处理（否则会算错坐标） */
      if (tag === 'svg') { skipped.nestedSvg++; continue; }

      if (tag === 'text' || tag === 'tspan' || tag === 'textpath' || tag === 'use') {
        collectColor(parsePaint(pickProp(el, 'fill', pStyle.fill, rules)));
        collectColor(parsePaint(pickProp(el, 'stroke', pStyle.stroke, rules)));
        continue;
      }

      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        const ctm = matMul(pCtm, parseTransformStr(el.getAttribute('transform')));
        const st = {
          fill: pickProp(el, 'fill', pStyle.fill, rules),
          stroke: pickProp(el, 'stroke', pStyle.stroke, rules),
          opacity: pickProp(el, 'opacity', pStyle.opacity, rules),
          fillOpacity: pickProp(el, 'fill-opacity', pStyle.fillOpacity, rules)
        };
        walk(Array.from(el.children), ctm, st);
        continue;
      }

      if (tag === 'line' || tag === 'polyline') {
        statsCollect.strokes++;
        const sp = parsePaint(pickProp(el, 'stroke', pStyle.stroke, rules));
        collectColor(sp);
        skipped.open++;
        continue;
      }

      if (!SHAPE_TAGS.has(tag)) continue;

      statsCollect.shapes++;
      const fillRaw = pickProp(el, 'fill', pStyle.fill, rules);
      const strokeRaw = pickProp(el, 'stroke', pStyle.stroke, rules);
      const fill = parsePaint(fillRaw);
      const stroke = parsePaint(strokeRaw);
      collectColor(fill);
      collectColor(stroke);

      /* 存在 <style> 却没有显式 fill 来源时，填充色可能来自未解析的选择器
         （#id / 后代 / 属性选择器等），此时不能按默认黑处理，否则会错误合并 */
      if (fillRaw === undefined && rules.length > 0) { skipped.unknownStyle++; continue; }

      // 屏幕显示用的 fill（无显式来源时 SVG 默认黑）
      const effFill = fill.kind === 'inherit' ? { kind: 'rgb', rgb: [0, 0, 0] } : fill;

      if (inHidden(el)) { skipped.hidden++; continue; }
      if (effFill.kind === 'none') { skipped.open++; continue; }
      if (effFill.kind === 'ref') { skipped.gradient++; continue; }
      if (effFill.kind !== 'rgb') { skipped.nonRgb++; continue; }
      if (el.hasAttribute('clip-path') || el.hasAttribute('mask')) { skipped.masked++; continue; }
      if (pickProp(el, 'clip-path', null, rules)) { skipped.masked++; continue; }
      if (pickProp(el, 'mask', null, rules)) { skipped.masked++; continue; }

      const op = parseFloat(pickProp(el, 'opacity', pStyle.opacity, rules));
      const fop = parseFloat(pickProp(el, 'fill-opacity', pStyle.fillOpacity, rules));
      if ((!isNaN(op) && op < 0.999) || (!isNaN(fop) && fop < 0.999)) { skipped.semiTransparent++; continue; }

      const rawD = shapeToD(el);
      if (!rawD) continue;

      const isPath = tag === 'path';
      if (isPath && !isClosedPath(rawD)) { skipped.open++; continue; }

      const ctm = matMul(pCtm, parseTransformStr(el.getAttribute('transform')));
      const d = flattenToAbsoluteD(rawD, ctm);
      if (!d) continue;

      // parentCtm：不含自身 transform 的祖先累积矩阵，回插时用于抵消祖先变换
      candidates.push({ el, d, key: toHex(effFill.rgb), ctm, parentCtm: pCtm });
    }
  }

  onProgress?.(5, '分析结构');
  /* 根元素的样式同样向子级继承（<svg fill="…"> 是合法写法），先收集为初始样式栈 */
  const rootStyle = {
    fill: pickProp(root, 'fill', undefined, rules),
    stroke: pickProp(root, 'stroke', undefined, rules),
    opacity: pickProp(root, 'opacity', undefined, rules),
    fillOpacity: pickProp(root, 'fill-opacity', undefined, rules)
  };
  walk(Array.from(root.children), ID, rootStyle);

  /* ---------- 按颜色分组（同色 ≥2 个才值得合并） ---------- */
  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c);
  }

  const mergeable = [];
  for (const [key, list] of groups) {
    if (list.length >= 2) mergeable.push({ key, list });
  }

  const stats = {
    colorCount: colorSet.size,
    colors: Array.from(colorSet),
    groups: groups.size,
    mergeGroups: mergeable.length,
    mergeGroupsDone: 0,
    beforeShapes: candidates.length,
    afterShapes: candidates.length,
    mergedShapes: 0,
    removedNodes: 0,
    anchorsPruned: 0,
    skipped,
    tolerance,
    ms: 0,
    shapesTotal: statsCollect.shapes
  };

  if (!mergeable.length) {
    stats.ms = performance.now() - t0;
    warnings.push('没有找到可合并的同色闭合路径组（需要同色 ≥ 2 个）');
    pushSkipWarnings(warnings, skipped);
    return { svg: svgText, stats, warnings };
  }

  /* ---------- Paper.js 合并 ---------- */
  let paper;
  try {
    onProgress?.(25, '加载几何引擎');
    paper = await loadPaper();
  } catch (e) {
    warnings.push('Paper.js 加载失败，已跳过同色合并：' + (e.message || e));
    stats.ms = performance.now() - t0;
    return { svg: svgText, stats, warnings };
  }

  onProgress?.(40, '同色路径合并');

  const results = new Map();     // key → { d, rule, removed, error }
  let done = 0;
  let anchorsPruned = 0;

  for (const g of mergeable) {
    const items = [];
    try {
      for (const c of g.list) {
        const p = new paper.Path({ pathData: c.d, insert: false });
        if (!p || !p.segments || !p.segments.length) continue;
        if (!p.closed) {
          /* 无 Z 但首尾点重合：显式闭合，并移除退化段 */
          const n = p.segments.length;
          const closeGap = n >= 3
            ? p.firstSegment.point.getDistance(p.lastSegment.point) : Infinity;
          if (closeGap <= 1) {
            p.closed = true;
            if (n > 3 && p.firstSegment.point.getDistance(p.lastSegment.point) < 0.01) {
              p.removeSegment(n - 1);
            }
          } else {
            continue;      // 真正开放：不参与合并
          }
        }
        items.push(p);
      }
      if (items.length < 2) continue;

      /* 分治联集：线性累积会让每次 unite 的输入越来越大（O(n²)），
         两两配对归并每层总成本 O(n)，2000 个色块实测快约一个数量级 */
      const acc = uniteBalanced(items);

      // 锚点简化：直线子路径走 D-P，含曲线子路径只清理冗余点
      const pruned = pruneAnchors(acc, tolerance);
      anchorsPruned += pruned;

      const node = acc.exportSVG({ precision: 2, asString: false });
      const dOut = node.getAttribute('d');
      if (dOut) {
        results.set(g.key, {
          d: dOut,
          rule: node.getAttribute('fill-rule') || 'nonzero',
          removed: g.list.length - 1,
          pruned
        });
      }
    } catch (e) {
      console.warn('合并失败，保留原样：', g.key, e);
      warnings.push('部分同色组合并失败，已保留原始结构');
    }
    done++;
    if (done % 4 === 0 || done === mergeable.length) {
      onProgress?.(40 + Math.round(40 * done / mergeable.length), '同色路径合并');
    }
  }

  /* ---------- 回插 DOM（保持 z 序） ---------- */
  onProgress?.(85, '写回结构');
  const groupIndex = new Map();
  let gi = 0;
  for (const g of mergeable) {
    if (!results.has(g.key)) continue;
    g.list.forEach((c, idx) => groupIndex.set(c.el, { key: g.key, first: idx === 0, gi }));
    gi++;
  }

  const DROP_ATTRS = new Set([
    'd', 'transform', 'clip-path', 'mask', 'style', 'opacity', 'fill-opacity', 'stroke-opacity',
    'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit',
    'fill', 'fill-rule', 'clip-rule', 'pathLength',
    'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points'
  ]);

  let merged = 0, removed = 0;
  for (const c of candidates) {
    const info = groupIndex.get(c.el);
    if (!info) continue;
    const res = results.get(info.key);
    if (!res) continue;

    if (!info.first) {
      c.el.remove();
      removed++;
      continue;
    }

    const newEl = doc.createElementNS(SVGNS, 'path');
    for (const attr of Array.from(c.el.attributes)) {
      if (DROP_ATTRS.has(attr.name.toLowerCase())) continue;
      newEl.setAttribute(attr.name, attr.value);
    }
    /* 合并结果的 d 是绝对坐标；若原元素位于 <g transform> 内，
       需要补上祖先矩阵的逆，抵消祖先变换，否则会被二次变换（图形跑位） */
    const inv = invertM(c.parentCtm);
    if (inv && !isIdentityM(inv)) {
      newEl.setAttribute('transform',
        'matrix(' + inv.map(v => Math.round(v * 1e6) / 1e6).join(' ') + ')');
    }
    newEl.setAttribute('d', res.d);
    newEl.setAttribute('fill', info.key);
    if (res.rule === 'evenodd') newEl.setAttribute('fill-rule', 'evenodd');
    c.el.replaceWith(newEl);
    merged++;
  }

  stats.afterShapes = candidates.length - removed;
  stats.mergedShapes = merged;
  stats.removedNodes = removed;
  stats.anchorsPruned = anchorsPruned;
  stats.mergeGroupsDone = results.size;      // 实际成功的组数（可能少于 mergeGroups）

  /* ---------- 序列化 ---------- */
  let out = new XMLSerializer().serializeToString(root);
  if (!/^<\?xml/.test(out)) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;

  stats.ms = performance.now() - t0;
  onProgress?.(100, '完成');

  pushSkipWarnings(warnings, skipped);

  return { svg: out, stats, warnings };
}

/** 把各类跳过统计汇总成用户可读的提示 */
function pushSkipWarnings(warnings, skipped) {
  if (skipped.gradient) warnings.push(skipped.gradient + ' 个渐变/图案填充路径已跳过合并');
  if (skipped.masked) warnings.push(skipped.masked + ' 个带遮罩（clip-path/mask）的对象已跳过');
  if (skipped.open) warnings.push(skipped.open + ' 个开放线条/无填充路径已跳过');
  if (skipped.semiTransparent) warnings.push(skipped.semiTransparent + ' 个半透明对象已跳过（合并会改变叠加效果）');
  if (skipped.unknownStyle) warnings.push(skipped.unknownStyle + ' 个对象的填充色来源无法确定，已跳过合并');
  if (skipped.nestedSvg) warnings.push(skipped.nestedSvg + ' 个内嵌 SVG 已跳过');
  if (skipped.nonRgb) warnings.push('存在无法解析为 RGB 的颜色值，相关路径已跳过');
}

/**
 * 锚点简化：
 *   - 子路径全部为直线段 → Douglas-Peucker（偏差 ≤ tol，不引入曲线）
 *   - 含曲线段的子路径 → 仅移除重复点与共线冗余点（曲线保持原样）
 * @returns {number} 移除的锚点总数
 */
function pruneAnchors(item, tol) {
  let removedCount = 0;
  const children = item.className === 'CompoundPath' ? item.children.slice() : [item];

  for (const p of children) {
    if (!p.segments || p.segments.length < 3) continue;
    if (!p.closed) continue;

    const segs = p.segments;
    const allStraight = segs.every((s, i) => {
      const nx = segs[(i + 1) % segs.length];
      return s.handleOut.isZero() && nx.handleIn.isZero();
    });

    if (allStraight) {
      /* 全直线闭合环：以两个相距较远的锚点 a、b 把环拆成两段，各做 D-P。
         注意全程使用**原始 segment 索引**（曾把环索引当 segment 索引删除，会删错点破坏形状） */
      const pts = segs.map(s => ({ x: s.point.x, y: s.point.y }));
      const n = pts.length;
      const [a, b] = ringAnchors(pts);            // 返回升序 a < b

      const keep = new Uint8Array(n);
      keep[a] = 1;
      keep[b] = 1;

      // 段 1：a → b（正向）
      const idx1 = [];
      for (let i = a; i <= b; i++) idx1.push(i);
      if (idx1.length > 2) {
        const k1 = dpKeep(idx1.map(i => pts[i]), tol);
        idx1.forEach((oi, j) => { if (k1[j]) keep[oi] = 1; });
      }

      // 段 2：b → 环回 a（跨越数组末端）
      const idx2 = [];
      for (let i = b; i < n; i++) idx2.push(i);
      for (let i = 0; i <= a; i++) idx2.push(i);
      if (idx2.length > 2) {
        const k2 = dpKeep(idx2.map(i => pts[i]), tol);
        idx2.forEach((oi, j) => { if (k2[j]) keep[oi] = 1; });
      }

      for (let i = n - 1; i >= 0; i--) {
        if (!keep[i]) { p.removeSegment(i); removedCount++; }
      }
    } else {
      // 含曲线：只清理重复点与「直线段上的共线点」，绝不改曲线
      for (let i = segs.length - 1; i >= 0 && segs.length > 3; i--) {
        const prev = segs[(i - 1 + segs.length) % segs.length];
        const cur = segs[i];
        const next = segs[(i + 1) % segs.length];
        const straightBefore = prev.handleOut.isZero() && cur.handleIn.isZero();
        const straightAfter = cur.handleOut.isZero() && next.handleIn.isZero();
        if (!straightBefore || !straightAfter) continue;
        const d = segDist(cur.point, prev.point, next.point);
        if (d <= tol) { p.removeSegment(i); removedCount++; }
      }
    }
  }
  return removedCount;
}
