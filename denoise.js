/* ============================================================================
 * 对比度感知降噪（v5.6）
 *
 * 目的：解决"引擎去噪是**一刀切**"的矛盾 ——
 *   `filterSpeckle` 按面积丢掉所有小区域：调低 → 细节回来但噪声碎块也回来；
 *   调高 → 碎块少了但真实细节被误删。
 *   本模块在**进引擎之前**只抹平"局部对比度低"的像素（噪声/压缩噪点），
 *   **完整保留"对比度高"的像素**（真实边缘与细节），
 *   于是引擎就可以放心用**低去噪阈值**（保细节）。
 *
 * 做法（借鉴 ImageTracer 的 `blurradius` / `blurdelta` 选择性模糊）：
 *   对每个像素取 (2r+1) 窗口内**逐通道**的极差，取三通道中的最大者 `range`：
 *     range ≤ delta（低对比 = 噪声）→ 该像素替换为**它自己通道**的窗口均值；
 *     range >  delta（有边缘）      → **原样保留**。
 *
 * 复杂度：分离式滑窗极值（min/max 可分离）+ 积分图求均值，O(n)。
 * ⚠️ 注意：绝不能用"亮度均值"去修正各通道（会把彩色像素冲淡，PSNR 暴跌）。
 * ========================================================================== */

/** 单通道的分离式滑窗极值（先水平后垂直） */
function windowMinMax(plane, w, h, R) {
  const minH = new Uint8ClampedArray(w * h), maxH = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let mn = 255, mx = 0;
      const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      for (let k = x0; k <= x1; k++) { const v = plane[row + k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      minH[row + x] = mn; maxH[row + x] = mx;
    }
  }
  const minV = new Uint8ClampedArray(w * h), maxV = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      let mn = 255, mx = 0;
      for (let k = y0; k <= y1; k++) {
        const a = minH[k * w + x]; if (a < mn) mn = a;
        const b = maxH[k * w + x]; if (b > mx) mx = b;
      }
      minV[y * w + x] = mn; maxV[y * w + x] = mx;
    }
  }
  return { minV, maxV };
}

/** 单通道积分图（便于 O(1) 求窗口均值） */
function prefix(plane, w, h) {
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += plane[y * w + x];
      s[(y + 1) * (w + 1) + (x + 1)] = s[y * (w + 1) + (x + 1)] + row;
    }
  }
  return s;
}

/**
 * @param {ImageData} src
 * @param {{radius?:number, delta?:number}} opts radius=窗口半径(px)；delta=对比度阈值(0–255)
 * @returns {{imageData: ImageData, changed: number, smoothed: number}}
 */
export function contrastAwareDenoise(src, opts = {}) {
  const { radius = 2, delta = 12 } = opts;
  const w = src.width, h = src.height, d = src.data;
  const R = Math.max(1, Math.min(6, Math.round(radius)));
  const n = w * h;

  const out = new ImageData(w, h);
  const o = out.data;
  o.set(d);

  const planes = [], mins = [], maxs = [], sums = [];
  for (let c = 0; c < 3; c++) {
    const pl = new Uint8ClampedArray(n);
    for (let p = 0; p < n; p++) pl[p] = d[p * 4 + c];
    planes.push(pl);
    const { minV, maxV } = windowMinMax(pl, w, h, R);
    mins.push(minV); maxs.push(maxV); sums.push(prefix(pl, w, h));
  }

  const S = (w + 1);
  const cnt = (2 * R + 1) * (2 * R + 1);
  let changed = 0, smoothed = 0;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      /* 三通道极差取最大：任一通道有强边缘就整点保留 */
      let range = 0;
      for (let c = 0; c < 3; c++) {
        const r = maxs[c][p] - mins[c][p];
        if (r > range) range = r;
      }
      if (range > delta) continue;                       // 有边缘 → 原样保留

      const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      const a = (y1 + 1) * S + (x1 + 1), b = y0 * S + (x1 + 1), cc = (y1 + 1) * S + x0, dd = y0 * S + x0;
      smoothed++;
      const i = p * 4;
      for (let c = 0; c < 3; c++) {
        const mean = (sums[c][a] - sums[c][b] - sums[c][cc] + sums[c][dd]) / cnt;
        const nv = Math.round(mean);
        if (nv !== o[i + c]) changed++;
        o[i + c] = nv < 0 ? 0 : nv > 255 ? 255 : nv;
      }
    }
  }
  return { imageData: out, changed, smoothed };
}