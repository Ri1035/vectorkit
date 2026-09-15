/* ============================================================
 * CMYK 分色核心
 *
 * SVG / 屏幕颜色是 RGB（光的加色），印刷是 CMYK（油墨的减色）。
 * 本模块提供 RGB → CMYK 的朴素分色（GCR 黑版生成 + TAC 总油墨量限制），
 * 不依赖 ICC 色彩管理——数值是"数学 CMYK"，适合矢量素材交印厂重新校色，
 * 不能替代基于 ICC profile（如 FOGRA39）的精确分色。
 * ============================================================ */

const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  orange: [255, 165, 0], purple: [128, 0, 128], navy: [0, 0, 128], teal: [0, 128, 128],
  maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
  fuchsia: [255, 0, 255], gold: [255, 215, 0], pink: [255, 192, 203],
  brown: [165, 42, 42], beige: [245, 245, 220], ivory: [255, 255, 240],
  transparent: null
};

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/**
 * 解析 CSS 颜色值为 [r,g,b]（0–255）
 * 支持：#rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / 常用命名色
 * @returns {[number,number,number]|null} null 表示无法解析
 */
export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;

  if (s[0] === '#') {
    const hex = s.slice(1);
    const expand = h => h.length === 3 || h.length === 4
      ? h.split('').map(c => c + c).join('')
      : h;
    const full = expand(hex);
    if (full.length < 6) return null;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if ([r, g, b].some(isNaN)) return null;
    return [r, g, b];
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const val = v => v.endsWith('%') ? Math.round(parseFloat(v) * 2.55) : parseFloat(v);
      const [r, g, b] = parts.slice(0, 3).map(val);
      if ([r, g, b].some(isNaN)) return null;
      return [r, g, b];
    }
    return null;
  }

  return NAMED_COLORS[s] !== undefined ? NAMED_COLORS[s] : null;
}

/**
 * RGB → CMYK 朴素分色
 *
 * @param {number} r,g,b  0–255
 * @param {Object} opts
 * @param {number} opts.gcr  黑版生成比例 0–1（1 = 全黑版，黑/灰由 K 版承担，印刷惯例）
 * @param {number} opts.tac  总油墨量上限（Total Area Coverage），1 = 100%，默认 3.0（300%）
 * @returns {[number,number,number,number]} c/m/y/k，各 0–1
 */
export function rgbToCmyk(r, g, b, { gcr = 1, tac = 3.0 } = {}) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B);

  const k0 = 1 - max;                    // 该颜色的最大可生成黑版
  const k = clamp01(k0 * clamp01(gcr));  // GCR 控制实际生成多少
  const denom = 1 - k;

  let c, m, y;
  if (denom < 1e-6) {
    c = m = y = 0;                       // 纯黑
  } else {
    c = clamp01((1 - R - k) / denom);
    m = clamp01((1 - G - k) / denom);
    y = clamp01((1 - B - k) / denom);
  }

  /* TAC 裁剪：四色总和超限时按比例压 CMY，保住 K（黑版骨架不动） */
  const sum = c + m + y + k;
  const tacV = clamp01(tac / 1) * 4;     // 允许 1–4 区间
  if (sum > tacV && sum - k > 1e-6) {
    const f = (tacV - k) / (sum - k);
    c *= f; m *= f; y *= f;
  }

  return [c, m, y, k];
}

/** CMYK 数组 → EPS setcmykcolor 参数串 */
export function cmykStr([c, m, y, k]) {
  const f = v => String(Math.round(v * 1000) / 1000);
  return `${f(c)} ${f(m)} ${f(y)} ${f(k)}`;
}
