// 观感指标评估：ref/out 的 RGBA raw → jag / ssimEdge / speck
// 用法: node perceptual-eval.mjs <ref.raw> <out.raw> <w> <h>
// 归档副本：导入路径已按本目录（docs/handover/2026-11-07/scripts）指向仓库根。
import fs from 'node:fs/promises';
import { jagEnergy, ssimEdge, speckScore } from '../../../../perceptual.js';

const [refPath, outPath, wStr, hStr] = process.argv.slice(2);
const w = +wStr, h = +hStr;
const ref = new Uint8Array(await fs.readFile(refPath));
const got = new Uint8Array(await fs.readFile(outPath));
if (ref.length !== w * h * 4 || got.length !== w * h * 4) {
  console.error('raw size mismatch', ref.length, got.length, w, h);
  process.exit(1);
}
const jr = jagEnergy(ref, w, h);
const jo = jagEnergy(got, w, h);
const ss = ssimEdge(ref, got, w, h);
const sp = speckScore(got, w, h);
console.log(JSON.stringify({
  jagRef: jr.hf, jagOut: jo.hf, jagDelta: +(jo.hf - jr.hf).toFixed(3),
  ssimEdge: ss.mean, speck: sp.score, speckCount: sp.speckCount
}));
