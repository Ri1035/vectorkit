// 多图复测：默认档（cutout）下 近似色合并 开/关
import { chromium } from 'file:///C:/Users/Administrator/Desktop/svg/vectorkit/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'C:/Users/Administrator/Desktop/svg/vectorkit/docs/assets/verify';
const IMGS = ['winter-593.png', 'sunflower-475.png', 'mandala-366.png'];
const OUT = 'C:/Users/Administrator/Desktop/svg/_work/out6/multi';
fs.mkdirSync(OUT, { recursive: true });

// 参考图：白底合成、原始尺寸
for (const f of IMGS) {
  const ref = `${OUT}/${path.parse(f).name}_ref.png`;
  if (!fs.existsSync(ref)) {
    execFileSync('python', ['prep.py', `${DIR}/${f}`, `${OUT}/${path.parse(f).name}.raw`, ref], { encoding: 'utf8', cwd: 'C:/Users/Administrator/Desktop/svg/_work/scripts' });
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));

await page.goto('http://127.0.0.1:5188/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /就绪/.test((document.getElementById('engineText') || {}).textContent || ''), { timeout: 40000 });

const setSw = async (id, on) => page.locator(id).evaluate((el, v) => { el.checked = v; el.dispatchEvent(new Event('change')); }, on);
const rows = [];

for (const f of IMGS) {
  await page.locator('input[type=file]').first().setInputFiles(`${DIR}/${f}`);
  await page.waitForFunction(() => !document.getElementById('run1').disabled, { timeout: 60000 });
  for (const snap of [false, true]) {
    await setSw('#fillSnap', snap);
    await page.click('#run1');
    await page.waitForFunction(() => {
      const b = document.getElementById('run1');
      return b && !b.disabled && !b.querySelector('.spinner');
    }, { timeout: 180000 });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#dl1')]);
    const tag = `${path.parse(f).name}_${snap ? 'snap' : 'base'}`;
    const svgFile = `${OUT}/${tag}.svg`;
    await dl.saveAs(svgFile);
    execFileSync(process.execPath, ['render.mjs', svgFile, `${OUT}/${tag}.png`], { encoding: 'utf8', cwd: 'C:/Users/Administrator/Desktop/svg/_work/scripts' });
    const cmp = execFileSync('python', ['compare.py', `${OUT}/${path.parse(f).name}_ref.png`, `${OUT}/${tag}.png`, tag], { encoding: 'utf8', cwd: 'C:/Users/Administrator/Desktop/svg/_work/scripts' }).trim();
    const svg = fs.readFileSync(svgFile, 'utf8');
    rows.push({
      img: f, snap,
      psnr: +((cmp.match(/PSNR=\s*([\d.]+)/) || [])[1] || 0),
      seam: +((cmp.match(/seam=\s*(\d+)/) || [])[1] || 0),
      edge: +((cmp.match(/edgeCorr=([\d.]+)/) || [])[1] || 0),
      paths: (svg.match(/<path/gi) || []).length
    });
  }
}
console.log(JSON.stringify({ rows, errs: errs.slice(0, 6) }, null, 2));
await browser.close();
