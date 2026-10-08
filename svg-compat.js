/* ============================================================
 * SVG 老软件兼容输出
 *
 * 面向 CorelDRAW X4 / Illustrator CS 等 2008 年前后的老软件。
 * 这类软件的 SVG 解析器很弱，常见失败表现：
 *   - 图形全部堆到画布左上角
 *   - 线条错乱、路径丢失
 *   - 尺寸变成 1:1 像素而忽略 viewBox 缩放
 *
 * 触发原因（按实测概率排序）：
 *   1. 路径使用相对命令（小写 m/l/c）或省略重复命令 → 老解析器算错基准点
 *   2. 依赖 viewBox 缩放而没有显式 width/height
 *   3. 用 <style> + class 定义样式 → 老软件不解析 CSS，图元全变默认黑色/丢失
 *   4. <g transform> 不被支持 → 内容堆在原点
 *
 * 本模块把 SVG 规整成最保守的形态：绝对坐标 + 显式尺寸 + 样式全部写成属性 + 无 transform 依赖。
 * ============================================================ */

const NUM = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';

function fmt(v) {
  if (!isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

/**
 * 把 path 的 d 全部转换为绝对命令。
 * 支持 M L H V C S Q T A Z（大小写），输出统一为 M/L/C/Q/A/Z。
 */
export function absolutizePath(d) {
  const re = new RegExp(`([MmLlHhVvCcSsQqTtAaZz])|(${NUM})`, 'g');
  const tokens = [];
  let m;
  while ((m = re.exec(d)) !== null) tokens.push(m[0]);
  if (!tokens.length) return d;

  const out = [];
  let i = 0;
  let cx = 0, cy = 0;          // 当前点
  let sx = 0, sy = 0;          // 子路径起点
  let lastCx = null, lastCy = null;   // 上一个三次控制点
  let lastQx = null, lastQy = null;   // 上一个二次控制点
  let cmd = '';
  let prevCmd = '';

  const n = () => parseFloat(tokens[i++]);
  const has = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i++];
    }
    if (!cmd) { i++; continue; }

    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    switch (C) {
      case 'M': {
        let x = n(), y = n();
        if (rel) { x += cx; y += cy; }
        cx = x; cy = y; sx = x; sy = y;
        out.push(`M ${fmt(x)} ${fmt(y)}`);
        // 后续裸坐标按 L 处理
        while (has()) {
          let lx = n(), ly = n();
          if (rel) { lx += cx; ly += cy; }
          cx = lx; cy = ly;
          out.push(`L ${fmt(lx)} ${fmt(ly)}`);
        }
        break;
      }
      case 'L': {
        let x = n(), y = n();
        if (rel) { x += cx; y += cy; }
        cx = x; cy = y;
        out.push(`L ${fmt(x)} ${fmt(y)}`);
        break;
      }
      case 'H': {
        let x = n();
        if (rel) x += cx;
        cx = x;
        out.push(`L ${fmt(cx)} ${fmt(cy)}`);
        break;
      }
      case 'V': {
        let y = n();
        if (rel) y += cy;
        cy = y;
        out.push(`L ${fmt(cx)} ${fmt(cy)}`);
        break;
      }
      case 'C': {
        let x1 = n(), y1 = n(), x2 = n(), y2 = n(), x = n(), y = n();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        out.push(`C ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`);
        lastCx = x2; lastCy = y2;
        cx = x; cy = y;
        break;
      }
      case 'S': {
        let x2 = n(), y2 = n(), x = n(), y = n();
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        const prevIsCubic = prevCmd === 'C' || prevCmd === 'S';
        const x1 = prevIsCubic && lastCx !== null ? cx * 2 - lastCx : cx;
        const y1 = prevIsCubic && lastCy !== null ? cy * 2 - lastCy : cy;
        out.push(`C ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`);
        lastCx = x2; lastCy = y2;
        cx = x; cy = y;
        break;
      }
      case 'Q': {
        let x1 = n(), y1 = n(), x = n(), y = n();
        if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
        out.push(`Q ${fmt(x1)} ${fmt(y1)} ${fmt(x)} ${fmt(y)}`);
        lastQx = x1; lastQy = y1;
        cx = x; cy = y;
        break;
      }
      case 'T': {
        let x = n(), y = n();
        if (rel) { x += cx; y += cy; }
        const prevIsQuad = prevCmd === 'Q' || prevCmd === 'T';
        const x1 = prevIsQuad && lastQx !== null ? cx * 2 - lastQx : cx;
        const y1 = prevIsQuad && lastQy !== null ? cy * 2 - lastQy : cy;
        out.push(`Q ${fmt(x1)} ${fmt(y1)} ${fmt(x)} ${fmt(y)}`);
        lastQx = x1; lastQy = y1;
        cx = x; cy = y;
        break;
      }
      case 'A': {
        const rx = n(), ry = n(), rot = n(), laf = n(), sf = n();
        let x = n(), y = n();
        if (rel) { x += cx; y += cy; }
        out.push(`A ${fmt(rx)} ${fmt(ry)} ${fmt(rot)} ${laf} ${sf} ${fmt(x)} ${fmt(y)}`);
        cx = x; cy = y;
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

    if (C !== 'S') { lastCx = null; lastCy = null; }
    if (C !== 'T') { lastQx = null; lastQy = null; }
    prevCmd = C;
  }

  return out.join(' ');
}

/**
 * 把 SVG 规整为老软件可解析的保守形态。
 * @param {string} svgText 原 SVG 文本
 * @returns {string} 兼容后的 SVG 文本
 */
export function toLegacySvg(svgText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return svgText;
  }
  if (doc.querySelector('parsererror')) return svgText;

  const svg = doc.documentElement;

  /* 1. 显式尺寸：老软件忽略 viewBox 缩放时也能拿到正确的画布大小 */
  const vbRaw = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  let w = parseFloat(svg.getAttribute('width'));
  let h = parseFloat(svg.getAttribute('height'));
  if ((!w || !h) && vbRaw.length === 4) { w = vbRaw[2]; h = vbRaw[3]; }
  if (!w || !h) return svgText;

  /* 2. 视口规整为 0 0 w h，保证 viewBox 与 width/height 1:1，无需缩放 */
  svg.setAttribute('viewBox', `0 0 ${fmt(w)} ${fmt(h)}`);
  svg.setAttribute('width', fmt(w));
  svg.setAttribute('height', fmt(h));
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('version', '1.1');
  svg.removeAttribute('style');

  /* 3. 样式表转属性：老软件不解析 CSS */
  const styleRules = [];
  doc.querySelectorAll('style').forEach(node => {
    const txt = node.textContent || '';
    const re = /\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      styleRules.push({ cls: m[1], decls: m[2] });
    }
    node.remove();
  });

  const applyDecls = (el, decls) => {
    decls.split(';').forEach(part => {
      const idx = part.indexOf(':');
      if (idx < 0) return;
      const prop = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (!prop || !val) return;
      if (el.hasAttribute(prop)) return;   // 已有属性优先
      el.setAttribute(prop, val);
    });
  };

  doc.querySelectorAll('[class]').forEach(el => {
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    classes.forEach(c => {
      styleRules.filter(r => r.cls === c).forEach(r => applyDecls(el, r.decls));
    });
    el.removeAttribute('class');
  });

  /* 4. 路径绝对化：老解析器处理相对命令会算错基准点 */
  doc.querySelectorAll('path').forEach(p => {
    const d = p.getAttribute('d');
    if (d) {
      try { p.setAttribute('d', absolutizePath(d)); } catch { /* 保留原值 */ }
    }
    p.removeAttribute('pathLength');
  });

  /* 5. 去掉老软件容易出问题的元素与属性 */
  doc.querySelectorAll('metadata,title,desc,defs>style').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    el.removeAttribute('data-name');
    el.removeAttribute('id');
    el.removeAttribute('aria-label');
    if (el.getAttribute('opacity') === '1') el.removeAttribute('opacity');
    if (el.getAttribute('stroke-width') === '0') el.removeAttribute('stroke-width');
  });

  /* 6. 补默认填充，避免某些老软件按"无填充"处理而看不见图形 */
  doc.querySelectorAll('path,rect,circle,ellipse,polygon,polyline').forEach(el => {
    const hasFill = el.hasAttribute('fill');
    const hasStyleFill = (el.getAttribute('style') || '').indexOf('fill') >= 0;
    const hasStroke = el.hasAttribute('stroke') && el.getAttribute('stroke') !== 'none';
    if (!hasFill && !hasStyleFill && !hasStroke) el.setAttribute('fill', '#000000');
  });

  let out = new XMLSerializer().serializeToString(svg);
  if (!/^<\?xml/.test(out)) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  return out;
}


/**
 * 背景色还原：内部同色保护会把「与图像边缘相连的背景」轻微偏移颜色，
 * 使被同色背景包围的前景元素（眼白高光、内部白点）成为独立色层而被保留。
 * 矢量化完成后，把偏移后的背景色块改回原色（矢量阶段同色不影响显示，
 * 但能保证用户拿到的背景色与原始素材一致）。
 *
 * @param {string} svgText
 * @param {number[]} bg    原始背景色 [r,g,b]
 * @param {number} shade   偏移量（与预处理一致）
 * @param {number} [tol=6] 颜色匹配容差
 * @returns {string}
 */
export function restoreBackgroundColor(svgText, bg, shade, tol = 6) {
  if (!bg || !shade) return svgText;
  const shifted = bg.map(v => (v >= 128 ? Math.max(0, v - shade) : Math.min(255, v + shade)));
  if (shifted.every((v, i) => v === bg[i])) return svgText;
  const hex = a => a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const target = '#' + hex(shifted), back = '#' + hex(bg);
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch { return svgText; }
  if (doc.querySelector('parsererror')) return svgText;

  const parse = s => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  };
  let n = 0;
  doc.querySelectorAll('[fill]').forEach(el => {
    const c = parse(el.getAttribute('fill'));
    if (!c) return;
    if (Math.abs(c[0] - shifted[0]) <= tol && Math.abs(c[1] - shifted[1]) <= tol && Math.abs(c[2] - shifted[2]) <= tol) {
      el.setAttribute('fill', back);
      n++;
    }
  });
  return n ? new XMLSerializer().serializeToString(doc.documentElement) : svgText;
}


/**
 * 还原「内部元素保护」造成的颜色偏移（方案 E 的收尾步骤）。
 * 保护阶段把前景小元素（眼白/高光）的颜色统一偏移了 shift，使其与背景区分而被引擎保留；
 * 矢量化完成后按「位置 + 颜色」双重匹配找到对应图元，把颜色改回原色。
 *
 * @param {string} svgText
 * @param {Array<{cx:number,cy:number,from:number[],to:number[]}>} elements
 * @param {number} [tol=10] 颜色匹配容差
 * @returns {string}
 */
export function restoreProtectedColors(svgText, elements, tol = 40) {
  if (!elements || !elements.length) return svgText;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch { return svgText; }
  if (doc.querySelector('parsererror')) return svgText;

  const parse = s => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  };
  const hex = a => '#' + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  const paths = [];
  doc.querySelectorAll('path').forEach(el => {
    const rgb = parse(el.getAttribute('fill'));
    if (!rgb) return;
    const nums = (el.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g) || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = +nums[i], y = +nums[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    paths.push({ el, rgb, minX, minY, maxX, maxY });
  });

  let fixed = 0;
  for (const e of elements) {
    if (!e || !e.from || !e.to) continue;
    let matched = false;
    for (const p of paths) {
      const dc = Math.abs(p.rgb[0] - e.to[0]) + Math.abs(p.rgb[1] - e.to[1]) + Math.abs(p.rgb[2] - e.to[2]);
      if (dc > tol) continue;
      /* 位置匹配：元素中心需落在该图元的 bbox 内（含 2px 容差） */
      if (e.cx < p.minX - 2 || e.cx > p.maxX + 2 || e.cy < p.minY - 2 || e.cy > p.maxY + 2) continue;
      p.el.setAttribute('fill', hex(e.from));
      p.rgb = e.from.slice();
      fixed++;
      matched = true;
      break;
    }
    /* 回退匹配：仅当颜色匹配未命中（引擎输出的颜色有偏差）时，
       改用「位置 + 面积接近 + 颜色更接近元素原色」三重约束匹配 */
    if (!matched) {
      let best = null, bestA = Infinity;
      for (const p of paths) {
        if (e.cx < p.minX - 3 || e.cx > p.maxX + 3 || e.cy < p.minY - 3 || e.cy > p.maxY + 3) continue;
        const bw = p.maxX - p.minX, bh = p.maxY - p.minY;
        const area = bw * bh;
        const ratio = area / Math.max(1, e.area);
        if (ratio < 0.3 || ratio > 3) continue;
        /* 该图元的颜色应比周围更接近元素原色而非背景 */
        const dcFrom = Math.abs(p.rgb[0] - e.from[0]) + Math.abs(p.rgb[1] - e.from[1]) + Math.abs(p.rgb[2] - e.from[2]);
        if (dcFrom < bestA) { bestA = dcFrom; best = p; }
      }
      if (best && bestA <= 90) {
        best.el.setAttribute('fill', hex(e.from));
        best.rgb = e.from.slice();
        fixed++;
      }
    }
  }
  return fixed ? new XMLSerializer().serializeToString(doc.documentElement) : svgText;
}
