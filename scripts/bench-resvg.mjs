import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '../vendor/resvg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo-original.svg'), 'utf8');

await initWasm(new Response(fs.readFileSync(path.join(root, 'vendor', 'resvg_bg.wasm')), {
  headers: { 'Content-Type': 'application/wasm' }
}));

const lines = [];
for (const w of [256, 512, 1284, 2567]) {
  const t0 = Date.now();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: w } });
  const png = Buffer.from(r.render().asPng());
  lines.push(`width=${String(w).padEnd(5)} ${Date.now() - t0}ms  png=${(png.length / 1024).toFixed(0)}KB`);
}
console.log(lines.join('\n'));
