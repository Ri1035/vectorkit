/* ============================================================================
 * perceptual.js —— 观感指标（Perceptual Metrics）
 *
 * 为什么需要它：PSNR/MSE 对「碎块」几乎不敏感、对「边缘锯齿」的惩罚不等同于人眼感受。
 * 本项目已实测证伪「PSNR 可代表观感」（v5.3：PSNR +2.86 dB，用户反馈"更锯齿了"）。
 * 因此任何"更好/更差"的结论都必须附带这里的至少一个指标。
 *
 * 三个指标（一一对应用户原始诉求）：
 *   1. speckScore()  —— 「不要过多碎块 / 切色块」：小面积区域数 + 与邻色的色差加权
 *   2. jagEnergy()   —— 「边缘不要锯齿」：边缘带内的高频（阶梯状）能量
 *   3. ssimEdge()    —— 「不要丢失细节」：梯度幅值图的 SSIM
 *
 * ⚠️ 使用纪律（见 docs/PLAN_REVIEW_2026-10-13.md 第五节）：
 *   **指标必须先验证方向再用**。已验证结论见文件末尾 VERIFIED。
 *
 * 无任何依赖，纯函数，可同时用于浏览器与 Node（scripts/_verify-perceptual.cjs 是验证脚本）。
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * 颜色工具：sRGB → CIE Lab（用于色差 ΔE76 / ΔE2000 的简化版 ΔE76）
 * ------------------------------------------------------------------------ */

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** @returns {[number,number,number]} L 0..100, a/b 约 -128..127 */
function rgb2lab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // D65
  let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  let z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.0888300;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116));
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** ΔE76（CIE76），足以支撑"相邻区域色差是否显著"的判断 */
export function deltaE(lab1, lab2) {
  const dl = lab1[0] - lab2[0], da = lab1[1] - lab2[1], db = lab1[2] - lab2[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/* 灰度亮度（0..255），用 Rec.709 线性化权重 */
export function lumaAt(data, i) {
  return 0.2126 * srgbToLinear(data[i]) * 255
       + 0.7152 * srgbToLinear(data[i + 1]) * 255
       + 0.0722 * srgbToLinear(data[i + 2]) * 255;
}

/* ---------------------------------------------------------------------------
 * 指标 1：碎块 / 切色块
 *
 * 做法：
 *   1. 4-连通区域标记（按 Lab 距离 ≤ colorTol 判为同色）
 *   2. 对每个区域求：面积、Lab 均色
 *   3. 对每个区域，找其边界外侧环带（1~2px）的主导色 → 得到"邻色"
 *   4. 碎块分 = Σ over 小区域 ( colorDeltaE(区域, 邻色) × 面积权重 )
 *
 * 关键点：**不能只数小块数量**。
 *   - 面积大 + 与邻色差异大 → 是真实设计元素（不该罚）
 *   - 面积小 + 与邻色差异大 → 才是"切色块/碎块"（该罚）
 *   - 面积小 + 与邻色几乎相同 → 无害的抖动，罚了就是噪声（不该罚）
 * ------------------------------------------------------------------------ */

export function speckScore(data, w, h, opts = {}) {
  const colorTol = opts.colorTol ?? 10;      // Lab 距离，同色判定阈值
  const maxAreaRatio = opts.maxAreaRatio ?? 0.004; // 小块判定：面积占比上限
  const ringWidth = opts.ringWidth ?? 2;      // 邻色环带宽度（px）
  const total = w * h;

  const lab = new Float32Array(total * 3);
  for (let p = 0; p < total; p++) {
    const l = rgb2lab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    lab[p * 3] = l[0]; lab[p * 3 + 1] = l[1]; lab[p * 3 + 2] = l[2];
  }

  // 4-连通标记（显式栈，避免递归爆栈）
  const label = new Int32Array(total).fill(-1);
  const regions = []; // {sumL,sumA,sumB,count,area,border:[]}
  const stack = new Int32Array(total);
  for (let start = 0; start < total; start++) {
    if (label[start] !== -1) continue;
    const id = regions.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    const reg = { sumL: 0, sumA: 0, sumB: 0, count: 0, border: [], minX: w, minY: h, maxX: -1, maxY: -1 };
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p / w) | 0;
      reg.sumL += lab[p * 3]; reg.sumA += lab[p * 3 + 1]; reg.sumB += lab[p * 3 + 2];
      reg.count++;
      if (px < reg.minX) reg.minX = px;
      if (py < reg.minY) reg.minY = py;
      if (px > reg.maxX) reg.maxX = px;
      if (py > reg.maxY) reg.maxY = py;
      for (let k = 0; k < 4; k++) {
        const nx = px + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = py + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (label[q] !== -1) continue;
        const dl = lab[p * 3] - lab[q * 3], da = lab[p * 3 + 1] - lab[q * 3 + 1], db = lab[p * 3 + 2] - lab[q * 3 + 2];
        if (Math.sqrt(dl * dl + da * da + db * db) > colorTol) continue;
        label[q] = id;
        stack[sp++] = q;
      }
    }
    regions.push(reg);
  }

  // 计算每个区域的邻色（边界外侧环带的主导色）
  for (let id = 0; id < regions.length; id++) {
    const reg = regions[id];
    reg.mean = [reg.sumL / reg.count, reg.sumA / reg.count, reg.sumB / reg.count];
    // 环带像素按邻区 label 聚类，找与"本区色差最大"的那个邻区 —— 那是真正的"切色"
    let worst = null, worstD = 0;
    const seen = new Map();
    const x0 = Math.max(0, reg.minX - ringWidth), x1 = Math.min(w - 1, reg.maxX + ringWidth);
    const y0 = Math.max(0, reg.minY - ringWidth), y1 = Math.min(h - 1, reg.maxY + ringWidth);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const q = y * w + x;
        if (label[q] === id) continue;          // 环带只取区外
        // 必须在包围盒边缘一圈，否则会取到区域内部的洞
        if (x >= reg.minX + ringWidth && x <= reg.maxX - ringWidth &&
            y >= reg.minY + ringWidth && y <= reg.maxY - ringWidth) continue;
        const lq = label[q];
        if (lq === -1) continue;
        let e = seen.get(lq);
        if (!e) { e = { sumL: 0, sumA: 0, sumB: 0, n: 0 }; seen.set(lq, e); }
        e.sumL += lab[q * 3]; e.sumA += lab[q * 3 + 1]; e.sumB += lab[q * 3 + 2]; e.n++;
      }
    }
    for (const [lq, e] of seen) {
      const d = deltaE(reg.mean, [e.sumL / e.n, e.sumA / e.n, e.sumB / e.n]);
      if (d > worstD) { worstD = d; worst = lq; }
    }
    reg.borderDelta = worstD;
  }

  // 汇总：只罚「小块 × 高色差」
  let speckCount = 0, speckScoreVal = 0;
  const specks = [];
  const smallMax = total * maxAreaRatio;
  for (let id = 0; id < regions.length; id++) {
    const reg = regions[id];
    if (reg.count > smallMax) continue;
    if (reg.borderDelta < colorTol * 1.5) continue; // 邻色接近 → 无害抖动
    speckCount++;
    speckScoreVal += reg.borderDelta * Math.sqrt(reg.count);
    if (specks.length < 40) {
      specks.push({ area: reg.count, deltaE: +reg.borderDelta.toFixed(1),
        box: [reg.minX, reg.minY, reg.maxX - reg.minX + 1, reg.maxY - reg.minY + 1] });
    }
  }
  return {
    regions: regions.length,
    speckCount,
    /** 归一化碎块分（每 1000 px 的加权色差）。原始和会随分辨率平方增长，不可跨图比较 */
    score: +(speckScoreVal / (total / 1000)).toFixed(2),
    rawScore: +speckScoreVal.toFixed(1),
    specks,
  };
}

/* ---------------------------------------------------------------------------
 * 指标 2：边缘带高频能量（锯齿代理）
 *
 * 锯齿的本质 = 轮廓是像素阶梯 → 边缘带内存在**高频**（逐像素跳变）。
 * 平滑曲线在边缘带内是渐变的 → 高频弱。
 *
 * 做法：
 *   1. 求亮度图 Y
 *   2. Sobel 梯度幅值 → 边缘掩码（阈值取梯度的 90 百分位，自适应）
 *   3. 在边缘掩码**膨胀 1px** 的带内，计算高通残差的高频能量占比
 *
 * ⚠️ 高频用 Laplacian |∇²Y| 而非一阶差分：一阶差分在斜坡上也有值，
 *    二阶差分才真正只对"突变/阶梯"响应。
 * ------------------------------------------------------------------------ */

export function jagEnergy(data, w, h, opts = {}) {
  const bandPx = opts.bandPx ?? 1;          // 边缘带膨胀宽度
  const qp = opts.q ?? 0.90;                 // 边缘阈值分位

  const Y = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) Y[p] = lumaAt(data, p * 4);

  // Sobel 幅值
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (Y[i - w + 1] + 2 * Y[i + 1] + Y[i + w + 1]) - (Y[i - w - 1] + 2 * Y[i - 1] + Y[i + w - 1]);
      const gy = (Y[i + w - 1] + 2 * Y[i + w] + Y[i + w + 1]) - (Y[i - w - 1] + 2 * Y[i - w] + Y[i - w + 1]);
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  // 边缘阈值：分位数
  const sorted = Float32Array.from(mag).sort();
  const thr = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * qp))] || 1;
  const isEdge = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (mag[p] >= thr && thr > 0) isEdge[p] = 1;

  // 膨胀 bandPx
  const band = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!isEdge[i]) continue;
      band[i] = 1;
      for (let dy = -bandPx; dy <= bandPx; dy++)
        for (let dx = -bandPx; dx <= bandPx; dx++) band[i + dy * w + dx] = 1;
    }
  }

  // 高频 = |Laplacian|；同时记录带内总对比（梯度）作为归一化分母
  let hf = 0, base = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!band[i]) continue;
      const lap = Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w]);
      hf += lap; base += mag[i]; cnt++;
    }
  }
  if (!cnt) return { hf: 0, ratio: 0, edgePixels: 0 };
  return {
    hf: +(hf / cnt).toFixed(3),                                  // 带内平均高频能量（越高越锯）
    ratio: +(hf / (base + 1e-6)).toFixed(4),                     // 归一化：高频 / 梯度
    edgePixels: cnt,
  };
}

/* ---------------------------------------------------------------------------
 * 指标 3：细节 SSIM（细节保留代理）
 *
 * 在**梯度幅值图**上算 SSIM，而非亮度图：
 *   - 亮度 SSIM 会被"大面积颜色正确"主导 → 碎块/锯齿惩罚不足（这正是 PSNR 的问题）
 *   - 梯度 SSIM 直接看"结构边界是否还在" → 对"丢失明显"敏感
 *
 * 8×8 滑窗 + 11×11 高斯近似（σ=1.5 的 1D[1,6,15,20,15,6,1]/64 卷积，可分离）
 * ------------------------------------------------------------------------ */

function boxBlur(src, w, h, r) {
  // 积分图 O(1) 滑窗均值
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const s = ii[(y1 + 1) * (w + 1) + (x1 + 1)] - ii[y0 * (w + 1) + (x1 + 1)]
              - ii[(y1 + 1) * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

function gaussBlur(src, w, h) {
  // 可分离 11 核高斯 σ=1.5
  const k = [1, 6, 15, 20, 15, 6, 1], kr = 3, sum = 64;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -kr; d <= kr; d++) {
        const xx = Math.min(w - 1, Math.max(0, x + d));
        s += src[y * w + xx] * k[d + kr];
      }
      tmp[y * w + x] = s / sum;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let d = -kr; d <= kr; d++) {
        const yy = Math.min(h - 1, Math.max(0, y + d));
        s += tmp[yy * w + x] * k[d + kr];
      }
      out[y * w + x] = s / sum;
    }
  }
  return out;
}

export function ssimEdge(a, b, w, h, opts = {}) {
  // 两图必须**共用同一尺度**归一化（以参考图的 99 百分位为 1）。
  // ⚠️ 曾因各自归一化导致不同输出的梯度量级不可比，mean 出现 -0.31 这类无意义值。
  // 共用尺度后，mean 才是"结构保留率"，可跨配置比较。
  const gradOf = (data) => {
    const Y = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) Y[p] = lumaAt(data, p * 4);
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (Y[i - w + 1] + 2 * Y[i + 1] + Y[i + w + 1]) - (Y[i - w - 1] + 2 * Y[i - 1] + Y[i + w - 1]);
        const gy = (Y[i + w - 1] + 2 * Y[i + w] + Y[i + w + 1]) - (Y[i - w - 1] + 2 * Y[i - w] + Y[i + w + 1]);
        g[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return g;
  };
  const rawA = gradOf(a), rawB = gradOf(b);
  const sA = Float32Array.from(rawA).sort();
  const scale = sA[Math.min(sA.length - 1, Math.floor(sA.length * 0.99))] || 1;
  const ga = new Float32Array(w * h), gb = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    ga[i] = Math.min(1, rawA[i] / scale);
    gb[i] = Math.min(1, rawB[i] / scale);   // 不对称截断：过冲的高频正是"锯齿"，应保留
  }
  const C1 = 0.01 * 0.01, C2 = 0.03 * 0.03;
  const ma = gaussBlur(ga, w, h), mb = gaussBlur(gb, w, h);
  const saa = new Float32Array(w * h), sbb = new Float32Array(w * h), sab = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { saa[i] = ga[i] * ga[i]; sbb[i] = gb[i] * gb[i]; sab[i] = ga[i] * gb[i]; }
  const maa = boxBlur(saa, w, h, 5), mbb = boxBlur(sbb, w, h, 5), mab = boxBlur(sab, w, h, 5);

  let total = 0, n = 0, minV = Infinity, maxV = -Infinity;
  for (let y = 6; y < h - 6; y++) {
    for (let x = 6; x < w - 6; x++) {
      const i = y * w + x;
      const va = maa[i] - ma[i] * ma[i];
      const vb = mbb[i] - mb[i] * mb[i];
      const cov = mab[i] - ma[i] * mb[i];
      const s = ((2 * ma[i] * mb[i] + C1) * (2 * cov + C2)) /
                ((ma[i] ** 2 + mb[i] ** 2 + C1) * (va + vb + C2));
      total += s; n++;
      if (s < minV) minV = s;
      if (s > maxV) maxV = s;
    }
  }
  const mean = total / n;
  // 局部 SSIM 理论范围 [-1,1]；近零方差窗口会算出远越界的值（如 -1300），
  // 那是公式退化而非真实信息 → 报告时钳制，原始分布无参考价值。
  const clamp1 = v => Math.max(-1, Math.min(1, v));
  return { mean: +mean.toFixed(5), min: +clamp1(minV).toFixed(5), max: +clamp1(maxV).toFixed(5), windows: n };
}

/* ---------------------------------------------------------------------------
 * 汇总：一次算完三个指标
 * ------------------------------------------------------------------------ */

export function perceptualAll(refData, gotData, w, h, opts = {}) {
  const jagRef = jagEnergy(refData, w, h, opts);
  const jagGot = jagEnergy(gotData, w, h, opts);
  const spkRef = opts.withRefSpeck ? speckScore(refData, w, h, opts) : null;
  const spkGot = speckScore(gotData, w, h, opts);
  const ssim = ssimEdge(refData, gotData, w, h, opts);
  return {
    speck: { ref: spkRef, got: spkGot },
    jag: { ref: jagRef, got: jagGot, delta: +(jagGot.hf - jagRef.hf).toFixed(3) },
    ssimEdge: ssim,
  };
}

/* ============================================================================
 * VERIFIED —— 指标方向验证结论
 *
 * 纪律要求「指标先验证方向再使用」。分两级验证：
 *
 * ① 合成图方向验证（scripts/_verify-perceptual.mjs，**已纳入 npm test**）
 *    7 项断言全部通过 —— 抖动↑ ⇒ jag↑；注入异色小块 ⇒ speck↑；±3 无害抖动 ⇒ speck 不变；
 *    结构全毁 ⇒ ssimEdge 崩塌；模糊 ⇒ ssimEdge < 1。
 *
 * ② 真实图验证（scripts/_e2e-perceptual.html，bc.png 1024²，v6.8 实测）
 *    结论**部分符合预期、部分不**：
 *
 *    ✓ **jagEnergy 方向在真实图上得到印证**：去噪 14→8（用户 v5.3 抱怨"更锯齿"的那次改动）
 *      实测 jag.hf 40.37 → 41.00（simplify0）—— **升高，方向一致**。
 *    ✓ **simplify 确实降锯**：去噪8 下 simplify 0→1 使 jag.hf 41.00 → 40.15。
 *    ⚠️ **但区分度很弱**：全部 8 组配置挤在 jag.hf 39.5~42.3（约 7% 跨度）。
 *      原因：矢量化输出必然比"抗锯齿位图"阶梯化得多（原图仅 9.24），
 *      组间差异被这个巨大的固定落差淹没。
 *      → **用法：只能用于同批配置的相对比较，不能设绝对阈值**。
 *    ⚠️ **ssimEdge 在本组图上接近饱和且已证实会产生假信号**：8 组全在 0.400~0.450。
 *      细扫 simplify（0/0.5/1/1.5/2/3 × 去噪 8/6/4，共 18 组）时，它在 **simplify=1 处
 *      出现非单调凹陷**，且三个独立去噪档**精确复现同一模式**（PSNR 则单调无凹陷）。
 *      **肉眼核对 simplify 0/1/1.5 的渲染图：无法分辨差异** → 该凹陷是**指标假信号**，
 *      曾据此得出的"simplify 掉结构"推断已作废。
 *      → **ssimEdge 只能用于"结构是否整体崩塌"这类粗判，不可用于精细排序。**
 *    ⚠️ **speck.score 同因区分度弱**：147~169。可用于二分判断，不宜细排序。
 *
 * ⚠️ **使用铁律（本项目实测得出）**：
 *   1. **区分度不足 → 差值不可当结论**。0.05 的 ssimEdge 差 = 肉眼零可见差异。
 *      引用本文件任何指标差值前，**必须先做肉眼核对**。
 *   2. **非单调的孤立凹陷 = 先怀疑指标**。真实现象不会在多个独立轴上精确复现同一凹陷。
 *
 * ⚠️ **尚未验证**：三个指标对 **Vector Magic 与我们的实际输出** 能否给出与用户判断
 * 一致的排序（需要新的竞品导出物）。**未验证前，不得用它们下"比 VM 好/差"的结论。**
 * ==========================================================================*/
