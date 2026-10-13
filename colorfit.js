/* ============================================================================
 * 逐区域颜色拟合（v5.1）
 *
 * 依据（2026-10-13 对 Vector Magic 的同图同口径实测）：
 *   VM 的 bc.svg 里出现 #fffffd / #fffffe / #fefefe 这类**多个"近似白"变体** →
 *   它**不做调色板量化**，而是**给每个区域解出在该区域内的最优颜色**。
 *   实测 VM 的 PSNR 比我们高 +4.81 dB，且节点更少 —— 颜色误差是差距的主要来源之一。
 *
 * 本模块做的事：
 *   1. 按**绘制顺序**把每条 path 依次栅格化到一张"归属图"（owner map），
 *      记录每个像素**最终可见的是哪一条 path**（后画的覆盖先画的）；
 *   2. 对每条 path，在**其可见区域**内取源图颜色的**加权均值**（只统计 mask 内部像素，
 *      跳过抗锯齿边缘），得到该区域的真实颜色；
 *   3. 把该 path 的 fill 改写为这个均值色。
 *
 * 这样处理的好处：背景层那种"被大量形状遮挡"的区域也只会用到它**可见部分**的颜色，
 * 不会把整幅图的均值当作背景色。
 *
 * 约定：只处理带 `fill="…"` 的 `<path>`；`fill="none"`、渐变（`url(...)`）、
 *       `style="fill:…"` 一律跳过；可见像素过少的 path 保持原色。
 * ========================================================================== */

const TAG_RE = /<path\b[^>]*>/gi;
const FILL_RE = /\sfill\s*=\s*"([^"]*)"/i;
const D_RE = /\sd\s*=\s*"([^"]*)"/i;

const toHex = (r, g, b) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** 解析出所有带 fill 的 path 的位置/颜色（跳过不可处理的） */
function collectPaintablePaths(svgText) {
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(svgText)) !== null) {
    const tag = m[0];
    const fm = FILL_RE.exec(tag);
    if (!fm) continue;
    const fill = fm[1].trim();
    if (!fill || fill === 'none' || /^url\(/i.test(fill)) continue;
    const dm = D_RE.exec(tag);
    if (!dm || !dm[1].trim()) continue;
    const fillIdx = m.index + tag.indexOf(fm[0]) + fm[0].indexOf('"') + 1;
    out.push({ tagStart: m.index, tagEnd: m.index + tag.length, d: dm[1], fill, fillStart: fillIdx, fillLen: fill.length });
  }
  return out;
}

/**
 * @param {string} svgText
 * @param {{data:Uint8ClampedArray,width:number,height:number}} src 源位图 RGBA
 * @param {{maskSize?:number, minVisible?:number, onProgress?:Function, alphaCut?:number}} opts
 * @returns {{svg:string, changed:number, total:number, ms:number}}
 */
export function fitRegionColors(svgText, src, opts = {}) {
  const t0 = performance.now();
  const { maskSize = 512, minVisible = 6, alphaCut = 200, onProgress } = opts;

  const paths = collectPaintablePaths(svgText);
  if (!paths.length) return { svg: svgText, changed: 0, total: 0, ms: performance.now() - t0 };

  const SW = src.width, SH = src.height;
  const S = Math.max(64, Math.min(maskSize, Math.max(SW, SH)));
  const MW = Math.max(1, Math.round(SW * S / Math.max(SW, SH)));
  const MH = Math.max(1, Math.round(SH * S / Math.max(SW, SH)));

  const cv = document.createElement('canvas');
  cv.width = MW; cv.height = MH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  /* 归属图：owner[p] = path 索引（-1 = 未覆盖） */
  const owner = new Int16Array(MW * MH).fill(-1);
  const dpr = SW / MW;                       // mask 像素 → 源图像素的换算

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, MW, MH);
      /* 把 SVG 的坐标（源图坐标系）缩放到 mask 画布 */
      ctx.setTransform(MW / SW, 0, 0, MH / SH, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fill(new Path2D(p.d));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const px = ctx.getImageData(0, 0, MW, MH).data;
      for (let q = 0; q < MW * MH; q++) {
        if (px[q * 4 + 3] >= alphaCut) owner[q] = i;      // 后画覆盖先画 → 直接覆盖
      }
    } catch (e) {
      /* 解析不了的路径跳过（保持原色） */
    }
    if (onProgress && (i % 16 === 0)) onProgress(i + 1, paths.length);
  }

  /* 每条 path 的可见区域颜色统计 */
  const sums = new Float64Array(paths.length * 3);
  const counts = new Uint32Array(paths.length);
  for (let q = 0; q < MW * MH; q++) {
    const i = owner[q];
    if (i < 0) continue;
    const mx = q % MW, my = (q - mx) / MW;
    const sx = Math.min(SW - 1, Math.max(0, Math.round((mx + 0.5) * dpr - 0.5)));
    const sy = Math.min(SH - 1, Math.max(0, Math.round((my + 0.5) * dpr - 0.5)));
    const si = (sy * SW + sx) * 4;
    sums[i * 3] += src.data[si];
    sums[i * 3 + 1] += src.data[si + 1];
    sums[i * 3 + 2] += src.data[si + 2];
    counts[i]++;
  }

  /* 组装新的 fill（按 fillStart 从后往前替换，避免偏移） */
  const edits = [];
  let changed = 0;
  for (let i = 0; i < paths.length; i++) {
    const n = counts[i];
    if (n < minVisible) continue;
    const hex = toHex(sums[i * 3] / n, sums[i * 3 + 1] / n, sums[i * 3 + 2] / n);
    if (hex.toLowerCase() === paths[i].fill.toLowerCase()) continue;
    edits.push({ start: paths[i].fillStart, len: paths[i].fillLen, hex });
    changed++;
  }
  edits.sort((a, b) => b.start - a.start);
  let out = svgText;
  for (const e of edits) out = out.slice(0, e.start) + e.hex + out.slice(e.start + e.len);

  onProgress?.(paths.length, paths.length);
  return { svg: out, changed, total: paths.length, ms: performance.now() - t0 };
}
