// bc-test：强制 ×2 描摹（2560 网格）对比默认 1280 的几何增益
import { chromium } from 'file:///C:/Users/Administrator/Desktop/svg/vectorkit/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const IMG = 'C:/Users/Administrator/Desktop/svg/vectorkit/docs/assets/verify/bc-test.jpg';
const REF = 'C:/Users/Administrator/Desktop/svg/_work/out4/bc_ref.png';
const OUT = 'C:/Users/Administrator/Desktop/svg/_work/vm/res';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));

await page.goto('http://127.0.0.1:5188/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /就绪/.test((document.getElementById('engineText') || {}).textContent || ''), { timeout: 40000 });
await page.locator('input[type=file]').first().setInputFiles(IMG);
await page.waitForFunction(() => !document.getElementById('run1').disabled, { timeout: 60000 });

const rows = [];
for (const [name, res] of [['res_auto', 'auto'], ['res_2', '2']]) {
  await page.locator('#preRes').evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, res);
  await page.click('#run1');
  await page.waitForFunction(() => {
    const b = document.getElementById('run1');
    return b && !b.disabled && !b.querySelector('.spinner');
  }, { timeout: 300000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#dl1')]);
  const svg = `${OUT}/${name}.svg`, png = `${OUT}/${name}.png`;
  await dl.saveAs(svg);
  execFileSync(process.execPath, ['render.mjs', svg, png, '1280'], { encoding: 'utf8' });
  const cmp = execFileSync('python', ['compare.py', REF, png, name], { encoding: 'utf8' }).trim();
  const s = fs.readFileSync(svg, 'utf8');
  const stats = await page.evaluate(() => (document.getElementById('stats1') || {}).innerText.replace(/\s+/g, ' ').trim());
  rows.push({
    name,
    psnr: +((cmp.match(/PSNR=\s*([\d.]+)/) || [])[1] || 0),
    seam: +((cmp.match(/seam=\s*(\d+)/) || [])[1] || 0),
    edge: +((cmp.match(/edgeCorr=([\d.]+)/) || [])[1] || 0),
    paths: (s.match(/<path/gi) || []).length,
    nodes: (s.match(/[MmLlCcSsQqTtAaZz]/g) || []).length,
    stats
  });
}
console.log(JSON.stringify({ rows, errs: errs.slice(0, 5) }, null, 2));
await browser.close();
