/* ============================================================
 * SVG → CMYK EPS 转换器
 *
 * 输出 PostScript Level 2 EPS（纯文本），色值用 setcmykcolor。
 * 面向印刷场景：CorelDRAW / Illustrator / InDesign / RIP 均可导入。
 *
 * 支持元素：path / rect / circle / ellipse / line / polyline / polygon，
 *           继承 g 的 fill / stroke / transform。
 * 降级策略（附 warnings 返回）：
 *   - 渐变 / pattern 填充 → 取 stop 平均色
 *   - opacity < 1 → 忽略（EPS 无标准透明度），按不透明处理
 *   - text / use / clip-path → 忽略
 *   - clip 的区域裁剪不生效（RIP 通常也不裁）
 *
 * 坐标：SVG y 向下，EPS y 向上，输出前整体翻转；1 px = 1 pt。
 * 「透明底」：不铺背景矩形（EPS 无 alpha 通道，背景即纸张/下承印物）。
 * ============================================================ */

import { absolutizePath } from './svg-compat.js';
import { parseColor, rgbToCmyk, cmykStr } from './cmyk.js';

const KAPPA = 0.5522847498307936;

const fmt = v => {
  if (!isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
};

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

const apply = (m, x, y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
];

/** 解析 transform 属性为矩阵（局部坐标系，需与父矩阵相乘） */
function parseTransform(str) {
  let m = ID;
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str)) !== null) {
    const args = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let cur = ID;
    switch (t[1]) {
      case 'matrix':
        if (args.length >= 6) cur = args.slice(0, 6);
        break;
      case 'translate':
        cur = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
        break;
      case 'scale':
        cur = [args[0] || 1, 0, 0, args.length > 1 ? args[1] : (args[0] || 1), 0, 0];
        break;
      case 'rotate': {
        const a = (args[0] || 0) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const r = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          cur = matMul(matMul([1, 0, 0, 1, args[1], args[2]], r), [1, 0, 0, 1, -args[1], -args[2]]);
        } else cur = r;
        break;
      }
      case 'skewX':
        cur = [1, 0, Math.tan((args[0] || 0) * Math.PI / 180), 1, 0, 0];
        break;
      case 'skewY':
        cur = [1, Math.tan((args[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
        break;
    }
    m = matMul(m, cur);
  }
  return m;
}

const matScale = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ============================ 圆弧 → 贝塞尔 ============================ */

/** SVG 圆弧转三次贝塞尔段序列（每段 ≤ 90°），返回 [c1x,c1y,c2x,c2y,x,y][] */
export function arcToCubics(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = phiDeg * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const sign = (laf !== sf) ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / (den || 1e-12)));
  const cxp = co * rx * y1p / ry;
  const cyp = -co * ry * x1p / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sf && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sf && dTheta < 0) dTheta += 2 * Math.PI;

  const segments = Math.ceil(Math.abs(dTheta) / (Math.PI / 2)) || 1;
  const delta = dTheta / segments;
  const t = 4 / 3 * Math.tan(delta / 4);

  const out = [];
  let th = theta1;
  for (let i = 0; i < segments; i++) {
    const th2 = th + delta;
    const e1x = rx * Math.cos(th), e1y = ry * Math.sin(th);
    const e2x = rx * Math.cos(th2), e2y = ry * Math.sin(th2);
    const d1x = -rx * Math.sin(th), d1y = ry * Math.cos(th);
    const d2x = -rx * Math.sin(th2), d2y = ry * Math.cos(th2);
    const w = (ex, ey) => [cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy];
    const [c1x, c1y] = w(e1x + t * d1x, e1y + t * d1y);
    const [c2x, c2y] = w(e2x - t * d2x, e2y - t * d2y);
    const [ex, ey] = w(e2x, e2y);
    out.push([c1x, c1y, c2x, c2y, ex, ey]);
    th = th2;
  }
  return out;
}

/* ============================ 路径 → EPS 操作序列 ============================ */

/** 基本形状转 path d 字符串 */
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

  if (tag === 'line') {
    return `M ${num('x1')} ${num('y1')} L ${num('x2')} ${num('y2')}`;
  }

  if (tag === 'polygon' || tag === 'polyline') {
    const pts = (el.getAttribute('points') || '').trim()
      .split(/[\s,]+/).filter(Boolean).map(Number);
    if (pts.length < 4) return '';
    const seg = [`M ${pts[0]} ${pts[1]}`];
    for (let i = 2; i + 1 < pts.length; i += 2) seg.push(`L ${pts[i]} ${pts[i + 1]}`);
    if (tag === 'polygon') seg.push('Z');
    return seg.join(' ');
  }

  return '';
}

/**
 * 把（绝对坐标的）path d 转换为 EPS 绘图操作串。
 * @param {string} d   已 absolutize 的 path 数据
 * @param {number[]} m 含 Y 翻转的最终 CTM
 */
export function dToEpsOps(d, m) {
  const abs = absolutizePath(d);
  const re = /([MLCQAZ])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  const tokens = [];
  let tk;
  while ((tk = re.exec(abs)) !== null) tokens.push(tk[0]);

  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0;      // 当前点（原始 SVG 坐标——A/Q 的数学必须在变换前做）
  let sx = 0, sy = 0;      // 当前子路径起点（原始坐标）
  let started = false;
  const n = () => parseFloat(tokens[i++]);

  const T = (x, y) => { const p = apply(m, x, y); return [fmt(p[0]), fmt(p[1])]; };
  const emitM = (x, y) => {
    const [fx, fy] = T(x, y);
    out.push((started ? '\n' : '') + `${fx} ${fy} moveto`);
    cx = x; cy = y; started = true;
  };
  const emitL = (x, y) => {
    const [fx, fy] = T(x, y);
    out.push(`${fx} ${fy} lineto`);
    cx = x; cy = y;
  };
  const emitC = (x1, y1, x2, y2, x, y) => {
    const a = T(x1, y1), b = T(x2, y2), e = T(x, y);
    out.push(`${a[0]} ${a[1]} ${b[0]} ${b[1]} ${e[0]} ${e[1]} curveto`);
    cx = x; cy = y;
  };

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) { i++; continue; }

    switch (cmd) {
      case 'M': {
        emitM(n(), n());
        sx = cx; sy = cy;
        while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) emitL(n(), n());
        break;
      }
      case 'L': {
        emitL(n(), n());
        break;
      }
      case 'C': {
        emitC(n(), n(), n(), n(), n(), n());
        break;
      }
      case 'Q': {
        const qx = n(), qy = n(), ex = n(), ey = n();
        emitC(
          cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy),
          ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey),
          ex, ey
        );
        break;
      }
      case 'A': {
        const rx = n(), ry = n(), rot = n(), laf = n(), sf = n();
        const ax = n(), ay = n();
        const segs = arcToCubics(cx, cy, rx, ry, rot, laf, sf, ax, ay);
        for (const s of segs) emitC(s[0], s[1], s[2], s[3], s[4], s[5]);
        break;
      }
      case 'Z': {
        out.push('closepath');
        cx = sx; cy = sy;
        break;
      }
      default:
        i++;
    }
  }
  return out.join('\n');
}

/* ============================ 样式继承 ============================ */

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

function styleDecls(el) {
  const map = {};
  const styleAttr = el.getAttribute('style');
  if (styleAttr) {
    styleAttr.split(';').forEach(p => {
      const idx = p.indexOf(':');
      if (idx < 0) return;
      map[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    });
  }
  return map;
}

/**
 * 解析 <style> 中的规则（保留选择器原文，用 el.matches 求匹配）。
 * 若不解析 <style>，用 CSS 定义填充色的 SVG 会退回默认黑，导出的 EPS 颜色全错。
 */
function parseStyleSheet(doc) {
  const list = [];
  doc.querySelectorAll('style').forEach(node => {
    const txt = node.textContent || '';
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const decls = {};
      m[2].split(';').forEach(p => {
        const i = p.indexOf(':');
        if (i <= 0) return;
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        if (k && v) decls[k] = v;
      });
      if (!Object.keys(decls).length) continue;
      m[1].split(',').forEach(s => {
        const sel = s.trim();
        if (sel) list.push({ sel, decls });
      });
    }
  });
  return list;
}

const CSS_CACHE = new WeakMap();
function cssFor(el, rules) {
  if (!rules.length) return null;
  const hit = CSS_CACHE.get(el);
  if (hit && hit.rules === rules) return hit.value;
  let out = null;
  for (const r of rules) {                 // 后者覆盖前者，近似 CSS 层叠
    try {
      if (el.matches(r.sel)) out = Object.assign(out || {}, r.decls);
    } catch (e) { /* 不支持的伪类等选择器 */ }
  }
  CSS_CACHE.set(el, { rules, value: out });
  return out;
}

/** 合并 CSS 规则与 inline style（inline 优先级更高，与浏览器一致） */
function effDecls(el, rules) {
  const css = cssFor(el, rules);
  const inline = styleDecls(el);
  if (!css) return inline;
  return Object.assign({}, css, inline);
}

function pick(el, decls, prop, inherited, def) {
  if (decls[prop] !== undefined && decls[prop] !== '') return decls[prop];
  if (el.hasAttribute(prop)) return el.getAttribute(prop);
  return inherited !== undefined ? inherited : def;
}

/** 解析 paint 值：none / url(#id) / 颜色 */
function parsePaint(v) {
  if (!v) return { kind: 'inherit' };
  const s = String(v).trim();
  if (s === 'none') return { kind: 'none' };
  if (s === 'inherit' || s === 'context-fill' || s === 'context-stroke') return { kind: 'inherit' };
  const ref = /^url\(["']?#([^)"']+)["']?\)/.exec(s);
  if (ref) return { kind: 'ref', id: ref[1] };
  const rgb = parseColor(s);
  if (rgb) return { kind: 'rgb', rgb };
  return { kind: 'inherit' };
}

/* ============================ 主转换 ============================ */

/**
 * SVG → CMYK EPS
 * @param {string} svgText
 * @param {Object} opts
 * @param {boolean} opts.transparent  透明底（不铺白底矩形）
 * @param {number}  opts.gcr          黑版生成 0–1
 * @param {number}  opts.tac          总油墨量上限（如 3.0 = 300%）
 * @param {string}  opts.title        文件名（写入 %%Title）
 * @returns {{ eps: string, warnings: string[], shapes: number }}
 */
export function svgToCmykEps(svgText, opts = {}) {
  const { transparent = false, gcr = 1, tac = 3.0, title = 'untitled' } = opts;
  const warnings = new Set();
  const warn = s => warnings.add(s);

  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return { eps: '', warnings: ['SVG 解析失败'], shapes: 0 };
  }
  if (doc.querySelector('parsererror')) {
    return { eps: '', warnings: ['SVG 解析失败'], shapes: 0 };
  }

  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let W = parseFloat(svg.getAttribute('width')) || (vb.length === 4 ? vb[2] : 0);
  let H = parseFloat(svg.getAttribute('height')) || (vb.length === 4 ? vb[3] : 0);
  if (vb.length === 4 && (!W || !H)) { W = vb[2]; H = vb[3]; }
  if (!W || !H || W <= 0 || H <= 0) {
    return { eps: '', warnings: ['SVG 缺少可用的画布尺寸'], shapes: 0 };
  }
  W = Math.ceil(W * 100) / 100;
  H = Math.ceil(H * 100) / 100;

  /* <style> 规则表：CSS 定义的颜色在 SVG 里很常见，不解析会全部退回黑色 */
  const cssRules = parseStyleSheet(doc);

  /* 渐变 / pattern 平均色缓存 */
  const gradAvg = id => {
    const g = doc.getElementById(id);
    if (!g) return null;
    const tag = g.tagName.toLowerCase();
    if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;
    const stops = Array.from(g.querySelectorAll('stop'));
    if (!stops.length) return null;
    let r = 0, gg = 0, b = 0, ws = 0;
    for (const s of stops) {
      const sd = effDecls(s, cssRules);
      const rgb = parseColor(s.getAttribute('stop-color') || sd['stop-color']);
      if (!rgb) continue;
      const rawOp = s.getAttribute('stop-opacity') || sd['stop-opacity'];
      const w = parseFloat(rawOp == null ? '1' : rawOp) || 0;
      r += rgb[0] * w; gg += rgb[1] * w; b += rgb[2] * w; ws += w;
    }
    if (!ws) return null;
    warn('渐变已降级为平均色');
    return [r / ws, gg / ws, b / ws];
  };

  /* body 跳过 defs / metadata 等 */
  let body = [];
  for (const child of svg.children) {
    const t = child.tagName.toLowerCase();
    if (t === 'defs' || t === 'metadata' || t === 'style' || t === 'title' || t === 'desc') continue;
    body.push(child);
  }

  const cmds = [];     // 每个图形的 EPS 片段
  let shapes = 0;

  /* 根元素样式同样向下继承（<svg fill="…"> 是合法写法） */
  const rootDecls = effDecls(svg, cssRules);
  const rootStyle = {};
  for (const k of ['fill', 'stroke', 'fill-rule', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity']) {
    const v = pick(svg, rootDecls, k, undefined);
    if (v !== undefined) rootStyle[k] = v;
  }

  function walk(nodes, pCtm, pStyle) {
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        const decls = effDecls(el, cssRules);
        const ctm = matMul(pCtm, parseTransform(el.getAttribute('transform')));
        const st = { ...pStyle };
        for (const k of ['fill', 'stroke', 'fill-rule', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity']) {
          const v = pick(el, decls, k, undefined);
          if (v !== undefined) st[k] = v;
        }
        walk(Array.from(el.children), ctm, st);
        continue;
      }

      if (tag === 'text' || tag === 'tspan' || tag === 'textPath') {
        warn('文本元素已忽略（EPS 需要文字转曲线后再导出）');
        continue;
      }
      if (tag === 'use' || tag === 'symbol' || tag === 'image' || tag === 'foreignObject') {
        warn(tag + ' 元素已忽略');
        continue;
      }
      if (!SHAPE_TAGS.has(tag)) continue;

      const decls = effDecls(el, cssRules);
      const ctm = matMul(pCtm, parseTransform(el.getAttribute('transform')));

      let fill = parsePaint(pick(el, decls, 'fill', pStyle.fill, 'black'));
      let stroke = parsePaint(pick(el, decls, 'stroke', pStyle.stroke, 'none'));
      const rule = pick(el, decls, 'fill-rule', pStyle['fill-rule'], 'nonzero');
      const sw = parseFloat(pick(el, decls, 'stroke-width', pStyle['stroke-width'], '1')) || 1;

      for (const k of ['opacity', 'fill-opacity', 'stroke-opacity']) {
        const v = parseFloat(pick(el, decls, k, pStyle[k], '1'));
        if (!isNaN(v) && v < 0.999) warn('透明度已被忽略（EPS 不支持，按不透明输出）');
      }
      if (el.hasAttribute('clip-path') || decls['clip-path']) warn('clip-path 裁剪未应用');

      /* paint 解引用（渐变降级） */
      const resolve = p => {
        if (p.kind === 'ref') {
          const avg = gradAvg(p.id);
          return avg ? { kind: 'rgb', rgb: avg.map(v => Math.round(v)) } : { kind: 'rgb', rgb: [0, 0, 0] };
        }
        if (p.kind === 'inherit') {
          return { kind: 'rgb', rgb: tag === 'line' || tag === 'polyline' ? [0, 0, 0] : [0, 0, 0] };
        }
        return p;
      };
      fill = fill.kind === 'inherit' ? { kind: 'rgb', rgb: [0, 0, 0] } : resolve(fill);
      stroke = stroke.kind === 'inherit' ? { kind: 'none' } : resolve(stroke);
      if (tag === 'line') fill = { kind: 'none' };   // SVG 语义：line 不可填充

      if (fill.kind === 'none' && stroke.kind === 'none') continue;

      const d = shapeToD(el);
      if (!d) continue;

      const flip = [1, 0, 0, -1, 0, H];       // SVG y 向下 → EPS y 向上
      const full = matMul(flip, ctm);
      const ops = dToEpsOps(d, full);
      if (!ops.trim()) continue;
      shapes++;

      let seg = '';
      const paintCmyk = p => cmykStr(rgbToCmyk(p.rgb[0], p.rgb[1], p.rgb[2], { gcr, tac }));

      seg += (seg ? '\n' : '') + 'newpath\n' + ops + '\n';
      if (fill.kind !== 'none') {
        seg += paintCmyk(fill) + ' setcmykcolor\n' + (rule === 'evenodd' ? 'eofill' : 'fill') + '\n';
      }
      if (stroke.kind !== 'none') {
        seg += 'gsave\n' + paintCmyk(stroke) + ' setcmykcolor\n'
          + fmt(sw * matScale(full)) + ' setlinewidth\nstroke\ngrestore\n';
      }
      cmds.push(seg);
    }
  }

  walk(body, ID, rootStyle);

  /* ---------- 组装 EPS ---------- */
  const esc = s => String(s).replace(/([()\\])/g, '\\$1');
  const head = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${fmt(W)} ${fmt(H)}`,
    `%%HiResBoundingBox: 0 0 ${fmt(W)} ${fmt(H)}`,
    '%%Creator: KOKA-VectorKit',
    `%%Title: (${esc(title)})`,
    `%%CreationDate: ${new Date().toUTCString()}`,
    '%%DocumentData: Clean7Bit',
    '%%LanguageLevel: 2',
    '%%Pages: 1',
    '%%EndComments',
    '%%Page: 1 1',
    'gsave'
  ].join('\n');

  const parts = [head];

  if (!transparent) {
    /* CMYK 纸白 = 四色全 0（不涂油墨），但铺出矩形可固定画布区域 */
    parts.push('newpath\n0 0 moveto ' + fmt(W) + ' 0 lineto ' + fmt(W) + ' ' + fmt(H)
      + ' lineto 0 ' + fmt(H) + ' lineto closepath\n0 0 0 0 setcmykcolor\nfill\n');
  } else {
    warn('透明底：EPS 无 alpha 通道，背景即纸张／下承印物');
  }

  parts.push(cmds.join('\n'));
  parts.push('grestore\nshowpage\n%%EOF\n');

  return {
    eps: parts.filter(Boolean).join('\n'),
    warnings: Array.from(warnings),
    shapes
  };
}
