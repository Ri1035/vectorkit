/* ============================================================
 * SVG → DXF 导出（AutoCAD R12 格式）
 *
 * 目标场景：切割机 / 激光雕刻 / CNC——这类软件普遍只认 DXF 或 AI，
 * 不认 SVG。采用 R12 是兼容性最优的选择（几乎所有老设备都支持）。
 *
 * 要点：
 *   - 坐标单位毫米（SVG px → mm：× 25.4 / 96，保持物理尺寸正确）
 *   - 曲线段采样为折线（每段 curveSamples 点，切割精度足够且解析器兼容性最好）
 *   - 按颜色分层（每个颜色一个图层，命名含 ACI 色号）——切割/激光可按层设参数
 *   - 颜色映射到 DXF 的 ACI 索引色（最近邻）
 *
 * 全部自研，无外部依赖。
 * ============================================================ */

/* ---------- ACI（AutoCAD 颜色索引）调色板 ---------- */

/** 生成 ACI 1–255 的 RGB 表（AutoCAD 索引色的标准规律） */
function buildAciPalette() {
  const pal = [null];                       // 索引 0 = 随层
  pal.push([255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255],
    [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]);
  /* 10–249：24 色调 × 10 亮度 */
  const hues = 24, shades = 10;
  for (let s = 0; s < shades; s++) {
    for (let h = 0; h < hues; h++) {
      const hue = h * 360 / hues;
      const v = s < 5 ? 1.0 : 1.0 - (s - 4) * 0.17;   // 前 5 档全亮，后 5 档渐暗
      const sat = s < 5 ? 1.0 : 1.0;
      const c = hsvToRgb(hue, sat, v);
      pal.push(c);
    }
  }
  /* 250–255 灰阶 */
  for (let i = 0; i < 6; i++) {
    const v = Math.round(255 * i / 5);
    pal.push([v, v, v]);
  }
  return pal;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const ACI_PALETTE = buildAciPalette();

/** RGB → 最近邻 ACI 索引 */
function aciFromRgb(rgb) {
  let best = 7, bestD = Infinity;
  for (let i = 1; i < ACI_PALETTE.length; i++) {
    const c = ACI_PALETTE[i];
    const d = (c[0] - rgb[0]) * (c[0] - rgb[0])
      + (c[1] - rgb[1]) * (c[1] - rgb[1])
      + (c[2] - rgb[2]) * (c[2] - rgb[2]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* ---------- 颜色与变换工具 ---------- */

function parseColorCss(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) return [+m[1] | 0, +m[2] | 0, +m[3] | 0];
  const named = { red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], black: [0, 0, 0], white: [255, 255, 255], yellow: [255, 255, 0] };
  return named[s] || null;
}

const IDENT = [1, 0, 0, 1, 0, 0];
const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use']);
function matMul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
function applyMat(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function parseTransform(str) {
  if (!str) return IDENT;
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str)) !== null) {
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let cur = IDENT;
    switch (t[1]) {
      case 'matrix': cur = v.slice(0, 6); break;
      case 'translate': cur = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': cur = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = (v[0] || 0) * Math.PI / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const rot = [cos, sin, -sin, cos, 0, 0];
        if (v.length >= 3) {
          cur = matMul(matMul([1, 0, 0, 1, v[1], v[2]], rot), [1, 0, 0, 1, -v[1], -v[2]]);
        } else cur = rot;
        break;
      }
    }
    m = matMul(m, cur);
  }
  return m;
}

/* ---------- path → 点集（含曲线采样） ---------- */

function pathToRings(d, samples = 10) {
  const toks = (d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []);
  const rings = [];
  let cur = [], cx = 0, cy = 0, sx = 0, sy = 0;
  let i = 0;
  const num = () => parseFloat(toks[i++]);
  const push = (x, y) => { cur.push([x, y]); };

  while (i < toks.length) {
    const t = toks[i++];
    const rel = t >= 'a' && t <= 'z';
    switch (t) {
      case 'M': case 'm': {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        if (cur.length > 1) rings.push(cur);
        cur = [];
        cx = x; cy = y; sx = x; sy = y; push(x, y);
        /* 连续的隐式 L */
        while (i < toks.length && /^[-+.\d]/.test(toks[i])) {
          let nx = num(), ny = num();
          if (rel) { nx += cx; ny += cy; }
          cx = nx; cy = ny; push(nx, ny);
        }
        break;
      }
      case 'L': case 'l': {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        cx = x; cy = y; push(x, y);
        break;
      }
      case 'H': case 'h': {
        let x = num();
        if (rel) x += cx;
        cx = x; push(cx, cy);
        break;
      }
      case 'V': case 'v': {
        let y = num();
        if (rel) y += cy;
        cy = y; push(cx, cy);
        break;
      }
      case 'C': case 'c': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x3 += cx; y3 += cy; }
        for (let k = 1; k <= samples; k++) {
          const tt = k / samples, mt = 1 - tt;
          push(
            mt * mt * mt * cx + 3 * mt * mt * tt * x1 + 3 * mt * tt * tt * x2 + tt * tt * tt * x3,
            mt * mt * mt * cy + 3 * mt * mt * tt * y1 + 3 * mt * tt * tt * y2 + tt * tt * tt * y3
          );
        }
        cx = x3; cy = y3;
        break;
      }
      case 'Q': case 'q': {
        let qx = num(), qy = num(), ex = num(), ey = num();
        if (rel) { qx += cx; qy += cy; ex += cx; ey += cy; }
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy);
        const c2x = ex + 2 / 3 * (qx - ex), c2y = ey + 2 / 3 * (qy - ey);
        for (let k = 1; k <= samples; k++) {
          const tt = k / samples, mt = 1 - tt;
          push(
            mt * mt * mt * cx + 3 * mt * mt * tt * c1x + 3 * mt * tt * tt * c2x + tt * tt * tt * ex,
            mt * mt * mt * cy + 3 * mt * mt * tt * c1y + 3 * mt * tt * tt * c2y + tt * tt * tt * ey
          );
        }
        cx = ex; cy = ey;
        break;
      }
      case 'Z': case 'z': {
        if (cur.length > 1) rings.push(cur);
        cur = [];
        cx = sx; cy = sy;
        break;
      }
      default:
        /* A/S/T 等：取样点退化为直线（描摹输出通常不含） */
        break;
    }
  }
  if (cur.length > 1) rings.push(cur);
  return rings;
}

/* ---------- DXF 输出 ---------- */

function dxfLine(code, value) {
  return String(code) + '\n' + String(value) + '\n';
}

/**
 * SVG → DXF（R12）。
 * @param {string} svgText
 * @param {Object} [opts]
 * @param {number} [opts.curveSamples] 每段曲线采样点数（默认 12）
 * @param {number} [opts.mmPerPx] px→mm 比例（默认 25.4/96）
 * @returns {{dxf:string, warnings:string[], shapes:number, layers:number}}
 */
export function svgToDxf(svgText, opts = {}) {
  const { curveSamples = 12, mmPerPx = 25.4 / 96 } = opts;
  const warnings = [];
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch (e) {
    return { dxf: '', warnings: ['SVG 解析失败'], shapes: 0, layers: 0 };
  }
  if (doc.querySelector('parsererror')) {
    return { dxf: '', warnings: ['SVG 解析失败'], shapes: 0, layers: 0 };
  }
  const svg = doc.documentElement;

  /* <style> 里的 class → fill 规则 */
  const classFill = {};
  doc.querySelectorAll('style').forEach(st => {
    const css = st.textContent || '';
    const re = /\.([\w-]+)\s*\{[^}]*?fill\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(css)) !== null) classFill[m[1]] = m[2].trim();
  });

  const layerMap = new Map();     // aci → { name, paths: rings[] }
  let shapes = 0;

  const walk = (el, ctm, inheritedFill) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'defs' || tag === 'metadata' || tag === 'style' || tag === 'title' || tag === 'desc') return;
    const m = matMul(ctm, parseTransform(el.getAttribute('transform')));

    /* 颜色：自身 fill 属性 > style 属性 > class 规则 > 继承 */
    let fill = null;
    const fillAttr = el.getAttribute('fill');
    if (fillAttr) fill = parseColorCss(fillAttr);
    if (!fill) {
      const st = el.getAttribute('style') || '';
      const sm = /fill\s*:\s*([^;]+)/.exec(st);
      if (sm) fill = parseColorCss(sm[1]);
    }
    if (!fill) {
      const cls = (el.getAttribute('class') || '').split(/\s+/).find(c => classFill[c]);
      if (cls) fill = parseColorCss(classFill[cls]);
    }
    if (!fill) fill = inheritedFill;

    if (tag === 'g' || tag === 'svg') {
      Array.from(el.children).forEach(child => walk(child, m, fill));
      return;
    }
    if (tag !== 'path') {
      if (SHAPE_TAGS.has(tag)) warnings.push(tag + ' 元素未转换（仅支持 path）');
      return;
    }
    const d = el.getAttribute('d');
    if (!d) return;

    const rings = pathToRings(d, curveSamples)
      .map(ring => ring.map(([x, y]) => applyMat(m, x, y)));
    if (!rings.length) return;

    const rgb = fill || [0, 0, 0];
    const aci = aciFromRgb(rgb);
    if (!layerMap.has(aci)) {
      layerMap.set(aci, {
        aci, rgb,
        name: 'C' + aci + '_' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''),
        rings: []
      });
    }
    layerMap.get(aci).rings.push(...rings);
    shapes++;
  };

  Array.from(svg.children).forEach(child => walk(child, IDENT, null));
  if (!layerMap.size) {
    return { dxf: '', warnings: ['SVG 中没有可导出的路径'], shapes: 0, layers: 0 };
  }

  /* ---- 组装 DXF ---- */
  let out = '';
  out += dxfLine(0, 'SECTION') + dxfLine(2, 'HEADER');
  out += dxfLine(9, '$ACADVER') + dxfLine(1, 'AC1009');
  out += dxfLine(9, '$INSUNITS') + dxfLine(70, 4);       // 4 = 毫米
  out += dxfLine(0, 'ENDSEC');

  out += dxfLine(0, 'SECTION') + dxfLine(2, 'TABLES');
  out += dxfLine(0, 'TABLE') + dxfLine(2, 'LAYER') + dxfLine(70, layerMap.size);
  for (const layer of layerMap.values()) {
    out += dxfLine(0, 'LAYER') + dxfLine(2, layer.name) + dxfLine(70, 0)
      + dxfLine(62, layer.aci) + dxfLine(6, 'CONTINUOUS');
  }
  out += dxfLine(0, 'ENDTAB') + dxfLine(0, 'ENDSEC');

  /* 全局原点：所有形状减去同一个 (minX, minY)，保持相对位置正确 */
  let minX = Infinity, minY = Infinity;
  for (const layer of layerMap.values()) {
    for (const ring of layer.rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }

  out += dxfLine(0, 'SECTION') + dxfLine(2, 'ENTITIES');
  let count = 0;
  for (const layer of layerMap.values()) {
    for (const ring of layer.rings) {
      if (ring.length < 2) continue;
      out += dxfLine(0, 'POLYLINE') + dxfLine(8, layer.name) + dxfLine(66, 1);
      /* 70: 1 = 闭合（首尾点相同则闭合，否则开口） */
      const first = ring[0], last = ring[ring.length - 1];
      const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.01;
      out += dxfLine(70, closed ? 1 : 0);
      out += dxfLine(10, 0) + dxfLine(20, 0) + dxfLine(30, 0);
      const pts = closed ? ring.slice(0, -1) : ring;
      for (const [x, y] of pts) {
        out += dxfLine(0, 'VERTEX') + dxfLine(8, layer.name);
        out += dxfLine(10, ((x - minX) * mmPerPx).toFixed(4))
          + dxfLine(20, ((y - minY) * mmPerPx).toFixed(4))
          + dxfLine(30, 0);
      }
      out += dxfLine(0, 'SEQEND') + dxfLine(8, layer.name);
      count++;
    }
  }
  out += dxfLine(0, 'ENDSEC');
  out += dxfLine(0, 'EOF');

  return { dxf: out, warnings, shapes: count, layers: layerMap.size };
}

