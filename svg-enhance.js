/* ============================================================================
 * svg-enhance.js —— v8.5 质量修复三件套（纯 SVG 文本变换，不改几何）
 *
 * 依据 Vector Magic 官方文档「勾画和/或填充」：
 *   ① 「仅填充」模式在多数查看器里会出现**细白线**：相邻面各自抗锯齿，各留 0.5px 半透明，
 *      合成后就是一条白缝。VM 的解法是「勾画 + 填充」——给每个形状加**同色描边**，
 *      用描边盖住这条缝。
 *   ② 同一视觉色在描摹结果里常带 ±2~3 的色差，现有的"精确同色"合并无法归并 → 色块不合并。
 *   ③ 白色背景本身是一条最大路径，它的抗锯齿边压在色块上，形成边缘白晕。
 *
 * 三个函数均为幂等的文本变换：只改 fill / stroke 属性或删除一条背景路径。
 * ==========================================================================*/

/** 红均值加权的近似感知距离（免 Lab 依赖，纯前端零成本） */
function colDist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  const rm = (a[0] + b[0]) / 2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

function parseHexColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    return [
      parseInt(m[1].slice(0, 2), 16),
      parseInt(m[1].slice(2, 4), 16),
      parseInt(m[1].slice(4, 6), 16)
    ];
  }
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(',').map(x => parseFloat(x));
    return [p[0] | 0, p[1] | 0, p[2] | 0];
  }
  return null;
}

const toHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/* ---------------------------------------------------------------------------
 * ① 近似色归并：把距离 ≤ tol 的填充色统一到出现次数最多的代表色。
 * 目的：让后续「同色路径合并」真正生效（±2 的色差会让同一视觉色各自成块）。
 * ------------------------------------------------------------------------ */
export function snapFillColors(svgText, opts = {}) {
  const { tol = 12 } = opts;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch { return { svg: svgText, colorsBefore: 0, colorsAfter: 0, changed: 0 }; }
  if (doc.querySelector('parsererror')) return { svg: svgText, colorsBefore: 0, colorsAfter: 0, changed: 0 };

  const els = Array.from(doc.querySelectorAll('path'));
  const freq = new Map();
  for (const el of els) {
    const c = parseHexColor(el.getAttribute('fill'));
    if (!c) continue;
    const hex = toHex(c);
    freq.set(hex, (freq.get(hex) || 0) + 1);
  }
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const reps = [];
  const map = new Map();
  for (const hex of colors) {
    const c = parseHexColor(hex);
    let best = null, bestD = Infinity;
    for (const r of reps) {
      const d = colDist(c, parseHexColor(r));
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && bestD <= tol) map.set(hex, best);
    else { reps.push(hex); map.set(hex, hex); }
  }

  let changed = 0;
  for (const el of els) {
    const c = parseHexColor(el.getAttribute('fill'));
    if (!c) continue;
    const hex = toHex(c);
    const rep = map.get(hex);
    if (rep && rep !== hex) { el.setAttribute('fill', rep); changed++; }
  }
  return {
    svg: new XMLSerializer().serializeToString(doc.documentElement),
    colorsBefore: colors.length,
    colorsAfter: reps.length,
    changed
  };
}

/* ---------------------------------------------------------------------------
 * ② 剥离白色背景层：只删「近白 + 节点最多」的那一条路径。
 * 预览区本身有白底，删掉后观感不变；小面积白色（眼白/高光）不会误删。
 * ------------------------------------------------------------------------ */
export function dropBackgroundLayer(svgText, opts = {}) {
  const { minChannel = 250, minNodes = 80 } = opts;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch { return { svg: svgText, dropped: false, fill: '' }; }
  if (doc.querySelector('parsererror')) return { svg: svgText, dropped: false, fill: '' };

  let target = null, bestNodes = 0;
  for (const el of doc.querySelectorAll('path')) {
    const c = parseHexColor(el.getAttribute('fill'));
    if (!c || Math.min(c[0], c[1], c[2]) < minChannel) continue;
    const n = ((el.getAttribute('d') || '').match(/[MmLlCcSsQqTtAaZz]/g) || []).length;
    if (n >= minNodes && n > bestNodes) { bestNodes = n; target = el; }
  }
  if (!target) return { svg: svgText, dropped: false, fill: '' };
  const fill = target.getAttribute('fill');
  target.remove();
  return { svg: new XMLSerializer().serializeToString(doc.documentElement), dropped: true, fill };
}

/* ---------------------------------------------------------------------------
 * ③ 同色描边补偿（VM 的「勾画 + 填充」）：stroke = fill，宽约 0.7（viewBox 单位）。
 * 用同色描边盖住相邻面之间 0.5px 的抗锯齿白缝。
 * 注意：切割类流程（乙烯/激光/绣花）每个形状会被切两次 → 该选项必须可关闭。
 * ------------------------------------------------------------------------ */
export function addStrokeCompensation(svgText, opts = {}) {
  const { width = 0.7 } = opts;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch { return { svg: svgText, stroked: 0 }; }
  if (doc.querySelector('parsererror')) return { svg: svgText, stroked: 0 };

  let stroked = 0;
  doc.querySelectorAll('path').forEach(el => {
    const fill = el.getAttribute('fill');
    if (!fill || fill === 'none') return;
    const st = el.getAttribute('stroke');
    if (st && st !== 'none') return;
    el.setAttribute('stroke', fill);
    el.setAttribute('stroke-width', String(width));
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    stroked++;
  });
  return { svg: new XMLSerializer().serializeToString(doc.documentElement), stroked };
}
