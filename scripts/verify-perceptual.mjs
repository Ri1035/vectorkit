#!/usr/bin/env node
/* 观感指标方向验证（perceptual.js）
 *
 * 纪律：指标必须先验证方向再使用（见 docs/PLAN_REVIEW_2026-10-13.md 第五节）。
 * 本脚本用合成图逐项断言方向，由 `npm test`（scripts/check-presets.cjs）自动调用。
 *
 * 原文件名以下划线开头（_verify-perceptual.mjs），被 .gitignore 的 `_*` 规则忽略，
 * 导致干净克隆上 `npm test` 必然失败；现改为不带下划线的正式脚本名。
 */

import { jagEnergy, speckScore, ssimEdge } from '../perceptual.js';

const W = 128, H = 128;

function makeImage(fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = fn(x, y);
      data[i] = v[0]; data[i + 1] = v[1]; data[i + 2] = v[2]; data[i + 3] = 255;
    }
  }
  return data;
}

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail++;
};

/* ---------- 1/2. jagEnergy：锯齿 ↑，指标 ↑；同一张图差异 ≈ 0 ---------- */

/* 平滑斜边：8px 线性渐变 */
const smooth = makeImage((x, y) => {
  const t = Math.max(0, Math.min(1, (x + y * 0.7 - 55) / 8));
  const v = Math.round(255 * t);
  return [v, v, v];
});

/* 阶梯斜边：同一条边硬阈值化 → 像素台阶 */
const jagged = makeImage((x, y) => {
  const v = (x + Math.floor(y * 0.7) >= 55) ? 255 : 0;
  return [v, v, v];
});

const jagSmooth = jagEnergy(smooth, W, H);
const jagJagged = jagEnergy(jagged, W, H);
const jagSame = jagEnergy(smooth, W, H);

ok(jagJagged.hf > jagSmooth.hf,
  `锯齿↑ ⇒ jag↑（平滑 ${jagSmooth.hf} → 阶梯 ${jagJagged.hf}）`);
ok(Math.abs(jagSame.hf - jagSmooth.hf) < 0.01,
  `同一张图 jag 不变（${jagSmooth.hf} vs ${jagSame.hf}）`);

/* ---------- 3/4. speckScore：异色小块 ↑，指标 ↑；±3 抖动不变 ---------- */

const flat = makeImage(() => [240, 240, 240]);
const withSpecks = makeImage((x, y) => {
  const inBlock = (bx, by) => x >= bx && x < bx + 3 && y >= by && y < by + 3;
  if (inBlock(20, 20) || inBlock(60, 50) || inBlock(90, 80)) return [255, 0, 255];
  return [240, 240, 240];
});

/* 确定性伪随机：避免每次运行结果漂移 */
let seed = 20261013;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fuzzy = makeImage(() => {
  const n = () => Math.round((rand() * 2 - 1) * 3);
  return [240 + n(), 240 + n(), 240 + n()];
});

const spkFlat = speckScore(flat, W, H);
const spkSpecks = speckScore(withSpecks, W, H);
const spkFuzzy = speckScore(fuzzy, W, H);

ok(spkSpecks.speckCount > spkFlat.speckCount && spkSpecks.score > spkFlat.score,
  `注入异色小块 ⇒ speck↑（${spkFlat.speckCount} → ${spkSpecks.speckCount} 块，score ${spkFlat.score} → ${spkSpecks.score}）`);
ok(spkFuzzy.speckCount === spkFlat.speckCount && spkFuzzy.score === spkFlat.score,
  `±3 无害抖动 ⇒ speck 不变（${spkFuzzy.speckCount} 块，score ${spkFuzzy.score}）`);

/* ---------- 5/6/7. ssimEdge：同图≈1；结构全毁崩塌；模糊 < 1 ---------- */

/* 参考图：铺满全图的棋盘结构（保证每个滑窗都有梯度，结构全毁时 ssim 才会真正崩塌） */
const bars = makeImage((x, y) => {
  const on = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) === 0;
  return on ? [235, 235, 235] : [20, 20, 20];
});

/* 结构全毁：均匀灰 */
const destroyed = makeImage(() => [128, 128, 128]);

/* 模糊：3×3 盒式均值 */
const blurred = (() => {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(W - 1, Math.max(0, x + dx));
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          sum += bars[(yy * W + xx) * 4];
          n++;
        }
      }
      const i = (y * W + x) * 4;
      const v = Math.round(sum / n);
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
})();

const ssimSame = ssimEdge(bars, bars, W, H);
const ssimBroken = ssimEdge(bars, destroyed, W, H);
const ssimBlur = ssimEdge(bars, blurred, W, H);

ok(ssimSame.mean > 0.95,
  `同图 ⇒ ssimEdge ≈ 1（${ssimSame.mean}）`);
ok(ssimBroken.mean < 0.2,
  `结构全毁 ⇒ ssimEdge 崩塌（${ssimBroken.mean}）`);
ok(ssimBlur.mean < ssimSame.mean,
  `模糊 ⇒ ssimEdge < 同图（${ssimBlur.mean} < ${ssimSame.mean}）`);

console.log('');
console.log(fail ? `✗ 失败 ${fail} 项` : '✓ 7 项方向断言全部通过');
process.exit(fail ? 1 : 0);
