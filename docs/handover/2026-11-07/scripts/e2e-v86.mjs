// v8.6 回归：默认 / 近似色合并开 / 纯合并 / 全关
import { chromium } from 'file:///C:/Users/Administrator/Desktop/svg/vectorkit/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const IMG = 'C:/Users/Administrator/Desktop/svg/vectorkit/docs/assets/verify/bc-test.jpg';
const OUT = 'C:/Users/Administrator/Desktop/svg/_work/out6';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto('http://127.0.0.1:5188/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /就绪/.test((document.getElementById('engineText') || {}).textContent || ''), { timeout: 40000 });
await page.locator('input[type=file]').first().setInputFiles(IMG);
await page.waitForFunction(() => !document.getElementById('run1').disabled, { timeout: 60000 });

const setSw = async (id, on) => page.locator(id).evaluate((el, v) => {
  el.checked = v; el.dispatchEvent(new Event('change'));
}, on);

const cases = [
  ['v86_default', false, true, true],
  ['v86_snap', true, true, true],
  ['v86_snap_pure', true, false, false],
  ['v86_alloff', false, false, false]
];

const rows = [];
for (const [name, snap, bg, stroke] of cases) {
  await setSw('#fillSnap', snap);
  await setSw('#dropBg', bg);
  await setSw('#strokeComp', stroke);
  const t0 = Date.now();
  await page.click('#run1');
  await page.waitForFunction(() => {
    const b = document.getElementById('run1');
    return b && !b.disabled && !b.querySelector('.spinner');
  }, { timeout: 180000 });
  const ms = Date.now() - t0;
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#dl1')]);
  const f = `${OUT}/${name}.svg`;
  await dl.saveAs(f);
  execFileSync(process.execPath, ['render.mjs', f, `${OUT}/${name}.png`, '1280'], { encoding: 'utf8', cwd: 'C:/Users/Administrator/Desktop/svg/_work/scripts' });
  const cmp = execFileSync('python', ['compare.py', 'C:/Users/Administrator/Desktop/svg/_work/out4/bc_ref.png', `${OUT}/${name}.png`, name], { encoding: 'utf8', cwd: 'C:/Users/Administrator/Desktop/svg/_work/scripts' }).trim();
  const svg = fs.readFileSync(f, 'utf8');
  const stats = await page.evaluate(() => (document.getElementById('stats1') || {}).innerText.replace(/\s+/g, ' ').trim());
  rows.push({
    name, ms,
    psnr: +((cmp.match(/PSNR=\s*([\d.]+)/) || [])[1] || 0),
    seam: +((cmp.match(/seam=\s*(\d+)/) || [])[1] || 0),
    edge: +((cmp.match(/edgeCorr=([\d.]+)/) || [])[1] || 0),
    paths: (svg.match(/<path/gi) || []).length,
    strokes: (svg.match(/stroke="/gi) || []).length,
    stats
  });
}
console.log(JSON.stringify({ rows, errs: errs.slice(0, 8) }, null, 2));
await browser.close();
