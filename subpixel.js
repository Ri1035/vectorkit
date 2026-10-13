/* ============================================================================
 * 亚像素边界重定位（v5.2 原型）
 *
 * 依据（v5.1 归因结论）：与 Vector Magic 的 −4.5 dB 差距**不是**颜色、参数或分辨率
 * （逐区域配色 VTracer 已在做；10 组样条参数全在 ±0.13 dB 内；双方同源 2048²），
 * **唯一剩余解释是「边界落在哪里」**。VM 的机制正是「用抗锯齿覆盖率反解亚像素边界」（Diebel 2008）。
 *
 * 本模块做的事（解析式、无需逐点试探）：
 *   1. 对每条闭合子路径的每个锚点，用相邻点估出**局部法线**；
 *   2. 沿法线在 ±range 内**双线性采样源图亮度**，找出 Lmin/Lmax 的中点 M；
 *   3. 找离锚点最近的 **L(t)=M 的交叉位置**（即抗锯齿给出的亚像素边界），线性插值出 t*；
 *   4. 把锚点（连同相邻控制点）沿法线平移 t*（限幅 ±maxShift）。
 *
 * 为什么不会撕开共享边界：**目标是"亮度 50% 交叉处"这个空间位置**，它是图像的性质，
 * 与遍历方向无关；相邻两面各自从自己那侧向同一位置收敛 → 结果一致。
 * （这与 v4.4 遇到的"逐路径各自重拟合"不同：那里是各拟合各的，这里指向同一目标。）
 *
 * 保守性：跳过角点（转角 > maxTurn）、跳过边缘不明显的点（亮度跨度 < minRange）、
 * 限幅位移；整体 MSE 未下降则**完全回滚**（fail-safe）。
 * ========================================================================== */

import { parseD, serializeSubpath, cloneSubpaths, shiftAnchor } from './refine.js';

const D_SLOT_RE = /(\sd\s*=\s*")([^"]*)(")/g;

/** 双线性亮度（0.299R+0.587G+0.114B） */
function lumAt(src, x, y) {
  const W = src.width, H = src.height;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  x0 = Math.min(W - 1, Math.max(0, x0)); y0 = Math.min(H - 1, Math.max(0, y0));
  const D = src.data;
  const L = (px, py) => { const i = (py * W + px) * 4; return 0.299 * D[i] + 0.587 * D[i + 1] + 0.114 * D[i + 2]; };
  const a = L(x0, y0), b = L(x1, y0), c = L(x0, y1), d = L(x1, y1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function mseOf(data, tgt) {
  let se = 0, n = 0;
  const N = Math.min(data.length, tgt.length);
  for (let i = 0; i < N; i += 4) {
    const d0 = data[i] - tgt[i], d1 = data[i + 1] - tgt[i + 1], d2 = data[i + 2] - tgt[i + 2];
    se += d0 * d0 + d1 * d1 + d2 * d2; n += 3;
  }
  return n ? se / n : Infinity;
}

/** 沿法线找"亮度中点"的交叉位置（返回 { off, why }；why ∈ moved/lowRange/noCross） */
function findCrossing(src, px, py, nx, ny, opts) {
  const { range = 1.6, step = 0.2, minRange = 24, maxShift = 0.8 } = opts;
  const ls = [];
  for (let t = -range; t <= range + 1e-9; t += step) ls.push(lumAt(src, px + nx * t, py + ny * t));
  let min = Infinity, max = -Infinity;
  for (const v of ls) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < minRange) return { off: 0, why: 'lowRange' };   // 这里没有明显边界 → 不动
  const mid = (min + max) / 2;
  let best = null;
  const at = (t) => lumAt(src, px + nx * t, py + ny * t) - mid;
  for (const dir of [1, -1]) {
    let prev = at(0), prevT = 0;
    for (let i = 1; i <= Math.ceil(range / step); i++) {
      const t = dir * i * step;
      const cur = at(t);
      if (prev === 0 || (prev > 0) !== (cur > 0)) {
        const frac = prev === cur ? 0 : prev / (prev - cur);
        const cross = prevT + (t - prevT) * frac;
        if (best === null || Math.abs(cross) < Math.abs(best)) best = cross;
        break;
      }
      prev = cur; prevT = t;
    }
  }
  if (best === null) return { off: 0, why: 'noCross' };
  return { off: Math.max(-maxShift, Math.min(maxShift, best)), why: 'moved' };
}

/**
 * @param {string} svgText
 * @param {{data:Uint8ClampedArray,width:number,height:number}} src
 * @param {{render:(svg:string)=>Promise<{data:Uint8ClampedArray}>, passes?:number, maxShift?:number,
 *          maxTurn?:number, minRange?:number, range?:number, precision?:number, onProgress?:Function}} opts
 */
export async function subpixelRefine(svgText, src, opts = {}) {
  const {
    render, passes = 2, maxShift = 0.8, maxTurn = 40, minRange = 24, range = 1.6,
    trustMax = 0.35, maxSegLen = 1e9, precision = 2, onProgress
  } = opts;
  const t0 = performance.now();
  const tgt = src.data;

  let current = svgText;
  let base = await render(current);
  let best = mseOf(base.data, tgt);
  const mseBefore = best;
  let renders = 1, moved = 0;
  /* 诊断用 */
  let lastTried = 0, lastCandidateMse = null, lastMeanOff = 0, lastMaxOff = 0, lastStat = null, lastCandidateSvg = null;

  for (let pass = 0; pass < passes; pass++) {
    const slots = [];
    D_SLOT_RE.lastIndex = 0;
    for (const m of current.matchAll(D_SLOT_RE)) {
      slots.push({ start: m.index + m[1].length, end: m.index + m[1].length + m[2].length, d: m[2] });
    }
    if (!slots.length) break;
    const parsed = slots.map(s => parseD(s.d));

    const nextD = new Array(slots.length);
    let movedThis = 0, sumAbsOff = 0, maxAbsOff = 0;
    const stat = { corner: 0, lowRange: 0, noCross: 0, tiny: 0, small: 0, mid: 0, big: 0 };

    for (let k = 0; k < parsed.length; k++) {
      const p = parsed[k];
      if (!p.ok) continue;
      const sps = cloneSubpaths(p.subpaths);
      for (const sp of sps) {
        if (!sp.closed || sp.segs.length < 3) continue;
        const segs = sp.segs;
        const n = segs.length;
        for (let gi = 0; gi < n; gi++) {
          const a = segs[gi], b = segs[(gi + 1) % n], z = segs[(gi - 1 + n) % n];
          if (a.cmd === 'M' && gi === 0 && n > 2) { /* 起点也处理 */ }
          /* 切线（用前后点）与法线 */
          const tx = b.to.x - z.to.x, ty = b.to.y - z.to.y;
          const tl = Math.hypot(tx, ty);
          if (tl < 1e-6) continue;
          const nx = -ty / tl, ny = tx / tl;

          /* 角点保护：转角过大则不动（v1=入向量、v2=出向量，直线时两者平行 → 转角 0） */
          const v1x = a.to.x - z.to.x, v1y = a.to.y - z.to.y;
          const v2x = b.to.x - a.to.x, v2y = b.to.y - a.to.y;
          const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
          if (l1 < 1e-6 || l2 < 1e-6) continue;
          let cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
          cos = Math.max(-1, Math.min(1, cos));
          const turn = Math.acos(cos) * 180 / Math.PI;      // 0° = 直线
          if (turn > maxTurn) { stat.corner++; continue; }
          /* 段长守卫：相邻段过长时，"锚点+控制点刚性平移"会把整段曲线推走 → 反而更差 */
          const lenIn = Math.hypot(a.to.x - z.to.x, a.to.y - z.to.y);
          const lenOut = Math.hypot(b.to.x - a.to.x, b.to.y - a.to.y);
          if (Math.max(lenIn, lenOut) > maxSegLen) { stat.longSeg = (stat.longSeg || 0) + 1; continue; }

          const fr = findCrossing(src, a.to.x, a.to.y, nx, ny, { range, minRange, maxShift });
          if (fr.why === 'lowRange') { stat.lowRange++; continue; }
          if (fr.why === 'noCross') { stat.noCross++; continue; }
          const ao = Math.abs(fr.off);
          if (ao < 0.05) { stat.tiny++; continue; }        // 已足够准
          /* 关键：位移过大说明"亮度中点交叉"很可能检错了（邻域含另一条边、法线不准）→ 不信任 */
          if (ao > trustMax) { stat.unreliable = (stat.unreliable || 0) + 1; continue; }
          if (ao < 0.15) stat.small++; else stat.mid++;
          shiftAnchor(sp, gi, nx * fr.off, ny * fr.off);
          movedThis++;
          sumAbsOff += ao;
          if (ao > maxAbsOff) maxAbsOff = ao;
          stat.moved = (stat.moved || 0) + 1;
        }
      }
      nextD[k] = sps.map(x => serializeSubpath(x, precision)).join('');
    }

    if (!movedThis) break;
    /* 回填（从后往前替换，避免索引漂移） */
    const order = [];
    for (let k = 0; k < slots.length; k++) if (nextD[k] !== undefined && nextD[k] !== slots[k].d) order.push(k);
    order.sort((a, b) => slots[b].start - slots[a].start);
    let cand = current;
    for (const k of order) cand = cand.slice(0, slots[k].start) + nextD[k] + cand.slice(slots[k].end);

    const r = await render(cand); renders++;
    const m = mseOf(r.data, tgt);
    lastTried = movedThis;
    lastStat = stat;
    lastCandidateSvg = cand;
    lastCandidateMse = m;
    lastMeanOff = movedThis ? sumAbsOff / movedThis : 0;
    lastMaxOff = maxAbsOff;
    onProgress?.(pass + 1, passes, m, best);
    if (m < best - 1e-9) { current = cand; best = m; moved += movedThis; }
    else break;                                   // 没有改善 → 停止后续 pass
  }

  const improved = best < mseBefore - 1e-9;
  return {
    svg: improved ? current : svgText,
    mseBefore, mseAfter: best, improved, moved, renders,
    tried: lastTried, candidateMse: lastCandidateMse, meanOffset: lastMeanOff, maxOffset: lastMaxOff, stat: lastStat, candidateSvg: lastCandidateSvg,
    ms: performance.now() - t0
  };
}
