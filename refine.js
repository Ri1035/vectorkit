/* ============================================================================
 * 重栅格化误差优化（实验原型，v4.10）
 *
 * 思路（对应 Diebel 2008 的"连续阶段"、DiffVG 的可微光栅化，纯前端近似版）：
 *   把当前 SVG 重新栅格化 → 与原图逐像素算误差 → 挑出「误差最大的少数锚点」，
 *   对每个锚点做**坐标下降**（试若干小偏移，保留使误差下降的那一个）。
 *
 * 设计原则：
 *   1. **fail-safe**：整体误差没有下降就完全回滚，绝不写回更差的结果；
 *   2. **有界**：锚点数 / 每锚点试探数 / 时间预算 三重上限，超时即停并返回当前最优；
 *   3. **低耦合**：渲染由调用方注入（`render(svg)` → RGBA），本模块不依赖 resvg/DOM；
 *   4. **最小改动**：只重写**被改动过的子路径**，其余路径的 `d` 原样保留。
 *
 * 支持的命令子集：M/m L/l C/c H/h V/v S/s Z/z（SVGO 后常见集合）；
 * 含 A/Q/T 等其它命令的路径**整条跳过**（保守，不动它）。
 * 仅移动**锚点**（段终点），并让相邻控制点同位移 → 局部刚性平移，保持切线方向。
 * ========================================================================== */

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function round(v, p) {
  const k = Math.pow(10, p);
  return Math.round(v * k) / k;
}

/** 解析一条 `d`：返回 { subpaths, ok }；不支持的命令 → ok=false */
export function parseD(d) {
  const toks = d.match(/[MmLlCcHhVvSsZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g);
  if (!toks) return { subpaths: [], ok: false };

  const subpaths = [];
  let cur = null;              // { segs: [...], closed: bool }
  let x = 0, y = 0;            // 当前点
  let sx = 0, sy = 0;          // 子路径起点
  let px = 0, py = 0;          // 上一控制点（供 S 反射）
  let lastC2 = null;           // 上一段的三次控制点2（绝对）
  let prevCmd = '';
  let i = 0;

  const push = (seg) => { cur.segs.push(seg); x = seg.to.x; y = seg.to.y; };

  while (i < toks.length) {
    const t = toks[i];
    if (!/^[A-Za-z]$/.test(t)) return { subpaths: [], ok: false };
    i++;
    const rel = t >= 'a' && t <= 'z';
    const C = t.toUpperCase();
    if ('AQTaqt'.includes(t)) return { subpaths: [], ok: false };

    const num = () => Number(toks[i++]);
    const ax = (v) => (rel ? x + v : v);
    const ay = (v) => (rel ? y + v : v);

    if (C === 'M') {
      const nx = ax(num()), ny = ay(num());
      cur = { segs: [{ cmd: 'M', to: { x: nx, y: ny } }], closed: false };
      subpaths.push(cur);
      x = nx; y = ny; sx = nx; sy = ny;
      prevCmd = 'M';
      // 后续隐式 L
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const lx = rel ? x + num() : num(), ly = rel ? y + num() : num();
        push({ cmd: 'L', to: { x: lx, y: ly } });
      }
      lastC2 = null;
      continue;
    }

    if (!cur) return { subpaths: [], ok: false };

    if (C === 'L') {
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const lx = ax(num()), ly = ay(num());
        push({ cmd: 'L', to: { x: lx, y: ly } });
      }
      lastC2 = null; prevCmd = 'L';
    } else if (C === 'H') {
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const nx = rel ? x + num() : num();
        push({ cmd: 'L', to: { x: nx, y } });
      }
      lastC2 = null; prevCmd = 'H';
    } else if (C === 'V') {
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const ny = rel ? y + num() : num();
        push({ cmd: 'L', to: { x, y: ny } });
      }
      lastC2 = null; prevCmd = 'V';
    } else if (C === 'C') {
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const x1 = ax(num()), y1 = ay(num());
        const x2 = ax(num()), y2 = ay(num());
        const x3 = ax(num()), y3 = ay(num());
        const seg = { cmd: 'C', c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, to: { x: x3, y: y3 } };
        x = x3; y = y3;
        cur.segs.push(seg);
        lastC2 = { x: x2, y: y2 };
        prevCmd = 'C';
      }
    } else if (C === 'S') {
      while (i < toks.length && !/^[A-Za-z]$/.test(toks[i])) {
        const x2 = ax(num()), y2 = ay(num());
        const x3 = ax(num()), y3 = ay(num());
        const refl = (prevCmd === 'C' || prevCmd === 'S') && lastC2
          ? { x: 2 * x - lastC2.x, y: 2 * y - lastC2.y }
          : { x, y };
        const seg = { cmd: 'C', c1: refl, c2: { x: x2, y: y2 }, to: { x: x3, y: y3 } };
        x = x3; y = y3;
        cur.segs.push(seg);
        lastC2 = { x: x2, y: y2 };
        prevCmd = 'S';
      }
    } else if (C === 'Z') {
      cur.closed = true;
      x = sx; y = sy;
      lastC2 = null; prevCmd = 'Z';
    } else {
      return { subpaths: [], ok: false };
    }
  }
  return { subpaths, ok: subpaths.length > 0 };
}

/** 把子路径序列化回 `d` 片段（绝对坐标，L/C 归一化） */
export function serializeSubpath(sp, precision = 2) {
  const f = (v) => round(v, precision);
  const out = [];
  for (let i = 0; i < sp.segs.length; i++) {
    const s = sp.segs[i];
    if (s.cmd === 'M') out.push('M' + f(s.to.x) + ' ' + f(s.to.y));
    else if (s.cmd === 'L') out.push('L' + f(s.to.x) + ' ' + f(s.to.y));
    else if (s.cmd === 'C') out.push('C' + f(s.c1.x) + ' ' + f(s.c1.y) + ' ' + f(s.c2.x) + ' ' + f(s.c2.y) + ' ' + f(s.to.x) + ' ' + f(s.to.y));
  }
  if (sp.closed) out.push('Z');
  return out.join('');
}

/** 收集全部锚点（供打分/选择） */
function collectAnchors(subpaths) {
  const list = [];
  subpaths.forEach((sp, si) => {
    sp.segs.forEach((seg, gi) => {
      if (seg.cmd === 'M' && gi === 0 && sp.closed && sp.segs.length > 1) return; // 起点交给末段处理
      list.push({ si, gi, x: seg.to.x, y: seg.to.y });
    });
  });
  return list;
}

/** 平移一个锚点：锚点本身 + 相邻控制点同位移（局部刚体平移，保持切线方向） */
function shiftAnchor(sp, gi, dx, dy) {
  const segs = sp.segs;
  const seg = segs[gi];
  seg.to = { x: seg.to.x + dx, y: seg.to.y + dy };
  if (seg.c2) seg.c2 = { x: seg.c2.x + dx, y: seg.c2.y + dy };      // 入控制点
  const nxt = segs[gi + 1];
  if (nxt) {
    if (nxt.c1) nxt.c1 = { x: nxt.c1.x + dx, y: nxt.c1.y + dy };    // 出控制点
    if (nxt.cmd === 'M') { nxt.to = { x: nxt.to.x + dx, y: nxt.to.y + dy }; }
  }
}

/** 深拷贝子路径（回滚用） */
const cloneSubpaths = (sps) => sps.map(sp => ({
  closed: sp.closed,
  segs: sp.segs.map(s => ({
    cmd: s.cmd, to: { ...s.to },
    ...(s.c1 ? { c1: { ...s.c1 } } : {}),
    ...(s.c2 ? { c2: { ...s.c2 } } : {})
  }))
}));

const OFFSETS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071],
  [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]
];

function mseOf(data, target) {
  let se = 0, n = 0;
  const N = Math.min(data.length, target.length);
  for (let i = 0; i < N; i += 4) {
    const d0 = data[i] - target[i], d1 = data[i + 1] - target[i + 1], d2 = data[i + 2] - target[i + 2];
    se += d0 * d0 + d1 * d1 + d2 * d2; n += 3;
  }
  return n ? se / n : Infinity;
}

/**
 * 重栅格化误差优化。
 * @param {string} svgText 当前 SVG
 * @param {Uint8ClampedArray} target 目标位图 RGBA（栅格化尺寸需一致）
 * @param {{render:(svg:string)=>Promise<{data:Uint8ClampedArray}>, maxAnchors?:number, trials?:number, maxShift?:number, timeBudgetMs?:number, precision?:number, onProgress?:Function}} opts
 * @returns {Promise<{svg:string, mseBefore:number, mseAfter:number, improved:boolean, accepted:number, renders:number, ms:number}>}
 */
export async function refineByRaster(svgText, target, opts = {}) {
  const {
    render,
    maxAnchors = 16,
    trials = 12,
    maxShift = 1.0,
    timeBudgetMs = 6000,
    precision = 2,
    onProgress
  } = opts;

  const t0 = performance.now();
  /* target 兼容两种形态：Uint8ClampedArray，或 {data,width,height}（ImageData / 自定义） */
  const tgt = (target && target.data) ? target.data : target;
  const TW = (target && target.width) || 0;
  const TH = (target && target.height) || 0;

  const base = await render(svgText);
  let best = mseOf(base.data, tgt);
  const mseBefore = best;
  let currentSvg = svgText;
  let renders = 1;
  let accepted = 0;

  if (!isFinite(best)) return { svg: svgText, mseBefore, mseAfter: mseBefore, improved: false, accepted: 0, renders, ms: performance.now() - t0 };

  /* 定位 SVG 里全部 path 的 d 片段（就地替换用） */
  const reD = /(\sd\s*=\s*")([^"]*)(")/g;
  const slots = [];
  for (const m of svgText.matchAll(reD)) slots.push({ start: m.index + m[1].length, end: m.index + m[1].length + m[2].length, d: m[2] });
  if (!slots.length) return { svg: svgText, mseBefore, mseAfter: mseBefore, improved: false, accepted: 0, renders, ms: performance.now() - t0 };

  const parsedAll = slots.map(s => parseD(s.d));

  /* 误差图 → 给每个锚点打分（5×5 邻域平方误差和） */
  const W = TW || base.width, H = TH || base.height;
  const errAt = (px, py) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return 0;
    const i = (py * W + px) * 4;
    const d0 = base.data[i] - tgt[i], d1 = base.data[i + 1] - tgt[i + 1], d2 = base.data[i + 2] - tgt[i + 2];
    return d0 * d0 + d1 * d1 + d2 * d2;
  };
  const scored = [];
  parsedAll.forEach((p, idx) => {
    if (!p.ok) return;
    for (const a of collectAnchors(p.subpaths)) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += errAt(Math.round(a.x) + dx, Math.round(a.y) + dy);
      scored.push({ idx, si: a.si, gi: a.gi, score: s, x: a.x, y: a.y });
    }
  });
  scored.sort((p, q) => q.score - p.score);
  const picked = scored.slice(0, maxAnchors);

  /* 坐标下降 */
  for (let n = 0; n < picked.length; n++) {
    if (performance.now() - t0 > timeBudgetMs) break;
    const a = picked[n];
    const p = parsedAll[a.idx];
    if (!p.ok) continue;
    const snapshot = cloneSubpaths(p.subpaths);
    let localBest = best, localSvg = null, localSp = null;

    for (let t = 0; t < Math.min(trials, OFFSETS.length); t++) {
      if (performance.now() - t0 > timeBudgetMs) break;
      const [ux, uy] = OFFSETS[t];
      const dx = ux * maxShift, dy = uy * maxShift;
      const trial = cloneSubpaths(snapshot);
      shiftAnchor(trial[a.si], a.gi, dx, dy);
      const dNew = trial.map(sp => serializeSubpath(sp, precision)).join('');
      const svgTrial = currentSvg.slice(0, slots[a.idx].start) + dNew + currentSvg.slice(slots[a.idx].end);
      const r = await render(svgTrial); renders++;
      const m = mseOf(r.data, tgt);
      if (m < localBest) { localBest = m; localSvg = svgTrial; localSp = trial; }
    }

    if (localSvg && localBest < best) {
      currentSvg = localSvg;
      slots[a.idx].end = slots[a.idx].start + serializeSubpath(localSp[0], precision).length; // 长度会变，后续用重算
      parsedAll[a.idx] = { subpaths: localSp, ok: true };
      best = localBest;
      accepted++;
      onProgress?.(n + 1, picked.length, best);
      /* d 长度变化后，重新定位所有 slot */
      const again = [];
      for (const m2 of currentSvg.matchAll(reD)) again.push({ start: m2.index + m2[1].length, end: m2.index + m2[1].length + m2[2].length, d: m2[2] });
      if (again.length === slots.length) for (let k = 0; k < again.length; k++) { slots[k].start = again[k].start; slots[k].end = again[k].end; }
    }
  }

  return {
    svg: currentSvg, mseBefore, mseAfter: best,
    improved: best < mseBefore - 1e-9,
    accepted, renders, ms: performance.now() - t0
  };
}
