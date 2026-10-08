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

/** 用 Paper 解析 path 数据（多子路径返回 CompoundPath） */
function parseShape(paper, d) {
  try {
    return new paper.CompoundPath({ pathData: d, insert: false });
  } catch (e) {
    try { return new paper.Path({ pathData: d, insert: false }); } catch (e2) { return null; }
  }
}

/** 取形状中最大子路径的面积（绝对值，px²） */
function maxSubpathArea(shape) {
  const kids = shape.className === 'CompoundPath' ? shape.children : [shape];
  let max = 0;
  for (const k of kids) {
    if (!k.segments || k.segments.length < 3) continue;
    const a = Math.abs(k.area || 0);
    if (a > max) max = a;
  }
  return max;
}

/** 形状是否闭合（合并/处理的前提） */
function ensureClosed(shape, maxGap = 1) {
  const kids = shape.className === 'CompoundPath' ? shape.children : [shape];
  let allClosed = true;
  for (const k of kids) {
    if (!k.segments || k.segments.length < 3) { allClosed = false; continue; }
    if (k.closed) continue;
    const n = k.segments.length;
    if (k.firstSegment.point.getDistance(k.lastSegment.point) <= maxGap) {
      k.closed = true;
      if (n > 3 && k.firstSegment.point.getDistance(k.lastSegment.point) < 0.01) k.removeSegment(n - 1);
    } else {
      allClosed = false;
    }
  }
  return allClosed;
}

/**
 * 合并同色闭合路径 + 矢量后处理
 * @param {string} svgText
 * @param {Object} opts
 * @param {number} opts.tolerance 锚点简化容差（px），推荐 0.02–0.1
 * @param {number} opts.minArea   碎块清理面积阈值（px²），小于该值的孤立碎块被删除；0 = 关闭
 * @param {number} opts.edgeSmooth 边缘平滑档位 0–3：1 = 仅去抖动（零变形）；2–3 = 叠加轻度曲线化
 * @param {(p:number, label:string)=>void} opts.onProgress
 * @returns {Promise<{svg:string, stats:Object|null, warnings:string[]}>}
 */
export async function mergeSameColorPaths(svgText, opts = {}) {
  const { tolerance = 0.05, minArea = 0, edgeSmooth = 0, fitK = 0, circleTol = 0.02, alignTol = 1.5, onProgress } = opts;
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
    droppedFragments: 0,
    refinedShapes: 0,
    skipped,
    tolerance,
    minArea,
    edgeSmooth,
    ms: 0,
    shapesTotal: statsCollect.shapes
  };

  const doMerge = mergeable.length > 0;
  const doFilter = minArea > 0;
  const doRefine = edgeSmooth > 0;      // 边缘平滑对单元素同样生效，必须计入早退判断
  if (!doMerge && !doFilter && !doRefine) {
    stats.ms = performance.now() - t0;
    if (!doMerge) warnings.push('没有找到可合并的同色闭合路径组（需要同色 ≥ 2 个）');
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
  const drops = new Set();        // 面积过小、判为碎块的元素
  const elemResults = new Map();  // Element → { d, rule }（未参与合并但被平滑/清理）
  let done = 0;
  let anchorsPruned = 0;

  for (const g of mergeable) {
    const items = [];
    try {
      for (const c of g.list) {
        const p = parseShape(paper, c.d);
        if (!p) continue;
        const kids = p.className === 'CompoundPath' ? p.children : [p];
        if (!kids.length) continue;
        if (!ensureClosed(p)) continue;      // 真正开放：不参与合并
        items.push(p);
      }
      if (items.length < 2) continue;

      /* 分治联集：线性累积会让每次 unite 的输入越来越大（O(n²)），
         两两配对归并每层总成本 O(n)，2000 个色块实测快约一个数量级 */
      const acc = uniteBalanced(items);

      // 碎块清理：整组并集后的最大子路径面积仍然过小 → 判为碎块删除
      if (doFilter && maxSubpathArea(acc) < minArea) {
        g.list.forEach(c => drops.add(c));
        done++;
        continue;
      }

      // 锚点简化（含可选的边缘平滑）
      const pruned = pruneAnchors(acc, tolerance, edgeSmooth, fitK, circleTol, alignTol);
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

  /* ---------- 单元素组：同样做碎块清理与边缘平滑 ---------- */
  if (doFilter || edgeSmooth > 0) {
    onProgress?.(82, '清理碎块');
    for (const [, list] of groups) {
      if (list.length >= 2) continue;
      const c = list[0];
      try {
        const p = parseShape(paper, c.d);
        if (!p) continue;
        const kids = p.className === 'CompoundPath' ? p.children : [p];
        if (!kids.length) continue;
        if (!ensureClosed(p)) continue;

        if (doFilter && maxSubpathArea(p) < minArea) { drops.add(c); continue; }

        if (edgeSmooth > 0) {
          const changed = pruneAnchors(p, tolerance, edgeSmooth, fitK, circleTol, alignTol);
          anchorsPruned += changed;
          // 仅在确有改动时才替换（无谓替换会重写 d 并引入多余 transform）
          if (changed > 0) {
            stats.refinedShapes++;
            const node = p.exportSVG({ precision: 2, asString: false });
            const dOut = node.getAttribute('d');
            if (dOut) {
              elemResults.set(c.el, { d: dOut, rule: node.getAttribute('fill-rule') || 'nonzero' });
            }
          }
        }
      } catch (e) { /* 单个元素失败不影响整体 */ }
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

  /** 用处理后的 d 替换原元素（保留元数据属性，补祖先矩阵的逆） */
  const applyShape = (c, d, rule) => {
    const newEl = doc.createElementNS(SVGNS, 'path');
    for (const attr of Array.from(c.el.attributes)) {
      if (DROP_ATTRS.has(attr.name.toLowerCase())) continue;
      newEl.setAttribute(attr.name, attr.value);
    }
    /* 结果的 d 是绝对坐标；若原元素位于 <g transform> 内，
       需要补上祖先矩阵的逆，抵消祖先变换，否则会被二次变换（图形跑位） */
    const inv = invertM(c.parentCtm);
    if (inv && !isIdentityM(inv)) {
      newEl.setAttribute('transform',
        'matrix(' + inv.map(v => Math.round(v * 1e6) / 1e6).join(' ') + ')');
    }
    newEl.setAttribute('d', d);
    newEl.setAttribute('fill', c.key);
    if (rule === 'evenodd') newEl.setAttribute('fill-rule', 'evenodd');
    c.el.replaceWith(newEl);
  };

  let merged = 0, removed = 0, dropped = 0, refined = 0;
  for (const c of candidates) {
    // 碎块清理：面积过小的孤立碎块直接删除
    if (drops.has(c)) { c.el.remove(); dropped++; continue; }

    const info = groupIndex.get(c.el);
    const res = info ? results.get(info.key) : null;

    if (!info || !res) {
      // 未参与合并：若边缘平滑改动了它，用新 d 替换
      const elem = elemResults.get(c.el);
      if (elem) { applyShape(c, elem.d, elem.rule); refined++; }
      continue;
    }

    if (!info.first) {
      c.el.remove();
      removed++;
      continue;
    }
    applyShape(c, res.d, res.rule);
    merged++;
  }

  stats.afterShapes = candidates.length - removed - dropped;
  stats.mergedShapes = merged;
  stats.removedNodes = removed;
  stats.anchorsPruned = anchorsPruned;
  stats.droppedFragments = dropped;
  stats.refinedShapes = Math.max(stats.refinedShapes, refined);
  stats.mergeGroupsDone = results.size;      // 实际成功的组数（可能少于 mergeGroups）

  /* ---------- 序列化 ---------- */
  let out = new XMLSerializer().serializeToString(root);
  if (!/^<\?xml/.test(out)) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;

  stats.ms = performance.now() - t0;
  onProgress?.(100, '完成');

  pushSkipWarnings(warnings, skipped);

  return { svg: out, stats, warnings };
}

/** 供测试直接调用（内部函数，生产流程不依赖） */
export const __test = { pruneAnchors, dpKeep, dpSimplifyStraightRuns, fitSmoothCurve, fitCircleShapes, snapAxisAlignedEdges, turnAngleDeg };

/** 把各类跳过统计汇总成用户可读的提示 */
function pushSkipWarnings(warnings, skipped) {  if (skipped.gradient) warnings.push(skipped.gradient + ' 个渐变/图案填充路径已跳过合并');
  if (skipped.masked) warnings.push(skipped.masked + ' 个带遮罩（clip-path/mask）的对象已跳过');
  if (skipped.open) warnings.push(skipped.open + ' 个开放线条/无填充路径已跳过');
  if (skipped.semiTransparent) warnings.push(skipped.semiTransparent + ' 个半透明对象已跳过（合并会改变叠加效果）');
  if (skipped.unknownStyle) warnings.push(skipped.unknownStyle + ' 个对象的填充色来源无法确定，已跳过合并');
  if (skipped.nestedSvg) warnings.push(skipped.nestedSvg + ' 个内嵌 SVG 已跳过');
  if (skipped.nonRgb) warnings.push('存在无法解析为 RGB 的颜色值，相关路径已跳过');
}

/**
 * 三点转角：偏离「直线」的度数（0 = 完全共线，90 = 直角）
 */
function turnAngleDeg(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-9 || len2 < 1e-9) return 0;
  let cos = (v1x * v2x + v1y * v2y) / (len1 * len2);
  cos = cos > 1 ? 1 : cos < -1 ? -1 : cos;
  const ang = Math.acos(cos) * 180 / Math.PI;   // 0 = 折返，180 = 直线
  return 180 - ang;
}

/** 直线段标记：段 i → i+1 是否为零句柄的直线 */
function straightFlags(segs) {
  const n = segs.length;
  const flags = new Array(n);
  for (let i = 0; i < n; i++) {
    flags[i] = segs[i].handleOut.isZero() && segs[(i + 1) % n].handleIn.isZero();
  }
  return flags;
}

/**
 * 对「纯折线区间」做 Douglas-Peucker。
 * 含曲线的子路径不能整体 D-P（会破坏曲线），但其中的直线段序列可以按容差
 * 删除抖动锚点——这是消除锯齿边缘的关键一步，且偏差有上界（= tol），不会变形。
 */
function dpSimplifyStraightRuns(p, tol) {
  const segs = p.segments;
  const n = segs.length;
  if (n < 4) return 0;
  const flags = straightFlags(segs);

  // 从一个非直线段之后开始，避免区间跨越数组首尾
  let base = 0;
  let found = false;
  for (let i = 0; i < n; i++) {
    if (!flags[i]) { base = (i + 1) % n; found = true; break; }
  }
  if (!found) return 0;                  // 全直线子路径由调用方另行处理

  const runs = [];
  let cur = null;
  for (let k = 0; k < n; k++) {
    const i = (base + k) % n;
    if (flags[i]) {
      if (cur) cur.push(i);
      else cur = [i];
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  let removed = 0;
  for (const run of runs) {
    const pts = [];
    for (const si of run) pts.push({ x: segs[si].point.x, y: segs[si].point.y, si });
    const lastSi = run[run.length - 1];
    const endIdx = (lastSi + 1) % n;
    pts.push({ x: segs[endIdx].point.x, y: segs[endIdx].point.y, si: endIdx });
    if (pts.length < 3) continue;

    const keep = dpKeep(pts, tol);
    const del = [];
    for (let i = 1; i < pts.length - 1; i++) if (!keep[i]) del.push(pts[i].si);
    del.sort((a, b) => b - a);           // 从后往前删，索引不失效
    for (const si of del) {
      if (p.segments.length <= 3) break;
      p.removeSegment(si);
      removed++;
    }
  }
  return removed;
}

/* 全曲线拟合档位：k = 句柄长度系数（相对相邻点距），protect = 硬边保护阈值
 * （偏转角 turn 超过 protect 的锐角/直角保持尖角，其余全部曲线化） */
const FIT_LEVELS = {
  2: { k: 0.35, protect: 65 },
  3: { k: 0.45, protect: 55 }
};

const STRAIGHT_TURN = 8;                 // 偏转角小于此值视为直线，不加句柄（保持 lineto）

/**
 * 全曲线拟合（硬边保护）：
 * 对重建后的折线逐点生成 Catmull-Rom 风格切线句柄——
 *   turn < STRAIGHT_TURN   → 直线点，不加句柄（EPS 里保持 lineto）
 *   turn ≤ cfg.protect     → 平滑区：对称切线句柄（曲线过锚点、G1 连续）
 *   turn > cfg.protect     → 锐角/直角：句柄清零（硬边不糊）
 * 曲线精确过每个锚点，形状偏差≈0；与「重采样简化」配合，实现细节保留 + 边缘平滑。
 * @returns {number} 加了句柄的点数
 */
function fitSmoothCurve(p, cfg) {
  const segs = p.segments;
  const n = segs.length;
  if (n < 3 || !cfg) return 0;
  let fitted = 0;
  for (let i = 0; i < n; i++) {
    const prev = segs[(i - 1 + n) % n];
    const cur = segs[i];
    const next = segs[(i + 1) % n];
    /* 只处理折线点：已有句柄的段保持原样（不干扰引擎原始曲线） */
    if (!prev.handleOut.isZero() || !cur.handleIn.isZero()) continue;
    if (!cur.handleOut.isZero() || !next.handleIn.isZero()) continue;

    const dPrev = cur.point.getDistance(prev.point);
    const dNext = cur.point.getDistance(next.point);
    const minD = Math.min(dPrev, dNext);
    if (minD < 0.8) continue;

    const turn = turnAngleDeg(prev.point, cur.point, next.point);
    if (turn < STRAIGHT_TURN) continue;          // 直线点：保持直线
    if (turn > cfg.protect) continue;            // 硬边保护：保持尖角

    cur.handleIn = prev.point.subtract(cur.point).normalize(minD * cfg.k);
    cur.handleOut = next.point.subtract(cur.point).normalize(minD * cfg.k);
    fitted++;
  }
  return fitted;
}

/** 三次贝塞尔在参数 t 处的点 */
function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

/** 闭合点列的 D-P：用 K 个等分锚点切成小段，段内简化（返回保留标记） */
function dpKeepRingPoints(pts, tol) {
  const n = pts.length;
  const K = Math.max(3, Math.min(24, Math.round(n / 8) || 3));
  const anchors = [];
  for (let k = 0; k < K; k++) anchors.push(Math.round(k * n / K) % n);
  anchors[0] = 0;

  const keep = new Uint8Array(n);
  for (const ai of anchors) keep[ai] = 1;

  for (let k = 0; k < anchors.length; k++) {
    const from = anchors[k];
    const to = anchors[(k + 1) % anchors.length];
    const idx = [];
    let i = from;
    let guard = 0;
    while (guard++ <= n) {
      idx.push(i);
      if (i === to) break;
      i = (i + 1) % n;
    }
    if (idx.length > 2) {
      const kk = dpKeep(idx.map(x => pts[x]), tol);
      idx.forEach((oi, j) => { if (kk[j]) keep[oi] = 1; });
    }
  }
  return keep;
}

/**
 * 把「近乎直线」的曲线段转为直线。
 * 很多曲线的控制点几乎落在起终点连线上（描摹抗锯齿边缘的产物），
 * 转直后既能被 D-P 简化，EPS 里也从 curveto 变成 lineto（更省）。
 *
 * ⚠️ 转直必须同时满足两个条件：
 *   1. 控制点偏离起终点连线 ≤ tol（单段近似直线）
 *   2. 该段与前一段的方向变化 < STRAIGHT_TURN（方向延续）
 * 只看条件 1 会把「由多段近似直线拼成的弧线」整条转直——弧线每一段
 * 单独看都接近直线，但方向在持续变化，转直后整圆变成多边形（锯齿根因）。
 */
function flattenNearStraightCurves(p, tol) {
  const segs = p.segments;
  const n = segs.length;
  if (n < 3) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % n];
    if (a.handleOut.isZero() && b.handleIn.isZero()) continue;   // 本来就是直线
    const c1 = a.point.add(a.handleOut);
    const c2 = b.point.add(b.handleIn);
    const dev = Math.max(
      segDist({ x: c1.x, y: c1.y }, a.point, b.point),
      segDist({ x: c2.x, y: c2.y }, a.point, b.point)
    );
    if (dev > tol) continue;
    /* 方向延续检查：与前一段的偏转角大 → 处在弧线上，不能转直 */
    const prev = segs[(i - 1 + n) % n];
    const turn = turnAngleDeg(prev.point, a.point, b.point);
    if (turn >= STRAIGHT_TURN) continue;
    a.handleOut.set(0, 0);
    b.handleIn.set(0, 0);
    changed++;
  }
  return changed;
}

/**
 * 曲线路径的简化：沿路径重采样 → D-P → 重建。
 * 这是让「曲线路径」也真正减少节点的关键——原先只对纯折线区间做 D-P，
 * 而描摹输出的曲线路径不含折线区间，导致简化完全不起作用。
 * 形状偏差由容差控制；档位 ≥2 时重建后再做浅转角曲线化，避免变成多边形。
 */
function resampleSimplify(p, tol, smoothLevel, fitK = 0) {
  const segs = p.segments;
  const n = segs.length;
  if (n < 4) return 0;

  const SPD = 5;                       // 每段采样点数
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % n];
    const p0 = { x: a.point.x, y: a.point.y };
    const p1 = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
    const p2 = { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y };
    const p3 = { x: b.point.x, y: b.point.y };
    for (let k = 0; k < SPD; k++) pts.push(cubicAt(p0, p1, p2, p3, k / SPD));
  }
  if (pts.length < 6) return 0;

  const keep = dpKeepRingPoints(pts, tol);
  const kept = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) kept.push(pts[i]);
  if (kept.length < 3 || kept.length >= n) return 0;   // 无收益就不动

  const Point = p.segments[0].point.constructor;
  p.removeSegments();
  for (const q of kept) p.add(new Point(q.x, q.y));
  p.closed = true;

  if (smoothLevel >= 2) fitSmoothCurve(p, { ...FIT_LEVELS[smoothLevel], k: fitK > 0 ? fitK : FIT_LEVELS[smoothLevel].k });
  return n - kept.length;
}

/**
 * 直线规整（正交吸附）：把「近似水平/垂直」的直线段吸附为精确的水平/垂直。
 *
 * 动机：设计稿里的直线本应是笔直的，但描摹后常带 0.5°–2° 的微小倾斜，
 * 放大或切割时肉眼可见。对纯直线段（不动曲线段）做轴向对齐即可修正；
 * 偏差阈值很小（默认 1.5°），避免改变设计上有意倾斜的元素。
 *
 * @param {paper.Path} p
 * @param {number} angleTol 允许吸附的最大角度偏差（度）
 * @returns {number} 吸附的段数
 */
function snapAxisAlignedEdges(p, angleTol = 1.5) {
  const segs = p.segments;
  const n = segs.length;
  if (n < 3) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % n];
    if (!p.closed && i === n - 1) break;
    /* 只处理纯直线段：任一端有句柄说明是曲线段，跳过 */
    if (!a.handleOut.isZero() || !b.handleIn.isZero()) continue;
    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const len = Math.hypot(dx, dy);
    if (len < 2) continue;
    const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);   // 0..180
    const devH = Math.min(ang, 180 - ang);                       // 距水平
    const devV = Math.abs(90 - ang);                             // 距垂直

    if (devH <= angleTol) {
      const y = (a.point.y + b.point.y) / 2;
      a.point.y = y; b.point.y = y;
      changed++;
    } else if (devV <= angleTol) {
      const x = (a.point.x + b.point.x) / 2;
      a.point.x = x; b.point.x = x;
      changed++;
    }
  }
  return changed;
}

/**
 * 几何基元拟合：把「近似圆」的闭合路径替换为标准圆（4 段三次贝塞尔）。
 *
 * 动机：描摹引擎对圆形（眼球、腮红、按钮等）的输出是 N 段折线/短曲线拼接，
 * 放大后呈多边形锯齿；后处理参数（容差/拟合强度）无法根治。
 * 用最小二乘圆拟合判定「够不够圆」（RMS 半径偏差 / 半径 ≤ tolRatio），
 * 够圆就重建为标准圆——节点数降到 4，边缘数学上完美平滑。
 *
 * @param {paper.Path} p
 * @param {number} tolRatio 允许的半径相对偏差（0.02 = 2%）
 * @returns {number} 减少的锚点数（未拟合返回 0）
 */
function fitCircleShapes(p, tolRatio = 0.02) {
  const segs = p.segments;
  const n = segs.length;
  /* 只处理「简单路径」：节点少的形状才可能是圆（眼球/腮红/高光）；
     节点多的复杂轮廓（头发、脸部外形）若被强制圆化会改变形状 */
  if (!p.closed || n < 8 || n > 60) return 0;

  /* 沿路径采样（曲线段也采），用于判定圆度 */
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % n];
    const p0 = { x: a.point.x, y: a.point.y };
    const p1 = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
    const p2 = { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y };
    const p3 = { x: b.point.x, y: b.point.y };
    const SPD = 4;
    for (let k = 0; k < SPD; k++) pts.push(cubicAt(p0, p1, p2, p3, k / SPD));
  }
  if (pts.length < 12) return 0;

  /* 最小二乘圆拟合（Kåsa 线性法） */
  let mx = 0, my = 0;
  for (const q of pts) { mx += q.x; my += q.y; }
  mx /= pts.length; my /= pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const q of pts) {
    const u = q.x - mx, v = q.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return 0;
  const uc = (svv * (suuu + suvv) - suv * (svvv + svuu)) / (2 * det);
  const vc = (suu * (svvv + svuu) - suv * (suuu + suvv)) / (2 * det);
  const cx = uc + mx, cy = vc + my;

  let rSum = 0;
  for (const q of pts) rSum += Math.hypot(q.x - cx, q.y - cy);
  const r = rSum / pts.length;
  if (r < 2) return 0;                     // 太小不处理（噪点级）
  let devSum = 0;
  for (const q of pts) {
    const d = Math.hypot(q.x - cx, q.y - cy) - r;
    devSum += d * d;
  }
  const rms = Math.sqrt(devSum / pts.length);
  if (rms / r > tolRatio) return 0;        // 不够圆 → 不动

  /* 重建为标准圆：4 点，每点带切线句柄（k = 0.5523 的圆弧近似） */
  const Pt = p.segments[0].point.constructor;
  const Seg = p.segments[0].constructor;
  const K = 0.5522847498;
  const h = r * K;
  const ring = [
    { p: [cx + r, cy], in: [0, -h], out: [0, h] },
    { p: [cx, cy + r], in: [h, 0], out: [-h, 0] },
    { p: [cx - r, cy], in: [0, h], out: [0, -h] },
    { p: [cx, cy - r], in: [-h, 0], out: [h, 0] }
  ];
  p.removeSegments();
  for (const seg of ring) {
    const s = new Seg(new Pt(seg.p[0], seg.p[1]));
    s.handleIn = new Pt(seg.in[0], seg.in[1]);
    s.handleOut = new Pt(seg.out[0], seg.out[1]);
    p.add(s);
  }
  p.closed = true;
  return n - 4;
}

/**
 * 锚点精简与边缘平滑：
 *   - 全直线子路径 → 整环 Douglas-Peucker（偏差 ≤ tol）
 *   - 含曲线子路径 → 近直线曲线段转直 + 折线区间 D-P；
 *     平滑档位 ≥ 2 时改为「重采样 + D-P + 全曲线拟合」，并尝试几何基元拟合（近似圆 → 标准圆）
 * @returns {number} 移除／改动的锚点总数
 */
function pruneAnchors(item, tol, smoothLevel = 0, fitK = 0, circleTol = 0.02, alignTol = 1.5) {
  let count = 0;
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
      /* 全直线闭合环：用 K 个「等分锚点」把环切成若干小段，段内做 D-P。
         关键教训：初始弦必须是**局部**的。曾用「最远点对」作初始弦，
         弦会横跨形状内部，环上所有点都被判为偏离过大，简化完全不生效。 */
      const pts = segs.map(s => ({ x: s.point.x, y: s.point.y }));
      const n = pts.length;
      const keep = dpKeepRingPoints(pts, tol);
      for (let i = n - 1; i >= 0; i--) {
        if (!keep[i]) { p.removeSegment(i); count++; }
      }
    } else if (smoothLevel >= 2) {
      // 曲线路径：重采样简化（真正减少节点）
      count += resampleSimplify(p, tol, smoothLevel, fitK);
      /* 几何基元拟合：近似圆 → 标准圆（节点降到 4，边缘完美平滑） */
      const circleCut = fitCircleShapes(p, circleTol);
      if (circleCut > 0) count += circleCut;
    } else {
      // 曲线路径（保守档）：先把近直线曲线段转直，再对折线区间做 D-P
      count += flattenNearStraightCurves(p, tol);
      count += dpSimplifyStraightRuns(p, tol);
    }
    /* 直线规整：所有档位都做（还原设计稿的笔直边，偏差阈值极小） */
    count += snapAxisAlignedEdges(p, alignTol);
  }
  return count;
}
