#!/usr/bin/env node
/* 回归守护：断言关键默认值不被误改，并校验 index.html 与 app.js 的 UI 契约。
   用法：npm test
   基线（2026-10-13 v5.3 起，双图实测确定）：默认 去噪8 + cutout + 无 simplify。 */

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function slice(startMark, endMark) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error('未找到起点: ' + startMark);
  const j = src.indexOf(endMark, i);
  if (j < 0) throw new Error('未找到终点: ' + endMark);
  return src.slice(i, j);
}

const sandbox = {};
new Function('exports',
  [slice('const PRESETS = {', 'const SCHEMA = {'),
   slice('const SCHEMA = {', 'const ADV = {'),
   slice('const ADV = {', 'const S1 = {')].join('\n') +
  '\nexports.PRESETS=PRESETS;exports.SCHEMA=SCHEMA;exports.ADV=ADV;')(sandbox);
const { PRESETS, SCHEMA, ADV } = sandbox;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

/* 模拟生产逻辑：预设值 → 滑杆/下拉默认值 → 下发守卫 */
function collect(engine, presetId) {
  const o = Object.assign({}, PRESETS[engine][presetId].opts);
  SCHEMA[engine].forEach(d => { o[d.key] = o[d.key] !== undefined ? o[d.key] : d.def; });
  ADV[engine].forEach(d => { o[d.key] = o[d.key] !== undefined ? o[d.key] : (d.type === 'select' ? d.options[0][0] : d.def); });
  if (!o.maxColors) delete o.maxColors;
  if (!o.simplify) delete o.simplify;
  if (o.clustering !== 'watershed') delete o.watershedDetail;
  if (!o.optimize) delete o.optimize;
  return o;
}

console.log('=== 预设集合 ===');
console.log('  vtracer: ' + Object.keys(PRESETS.vtracer).join(', '));
console.log('  potrace: ' + Object.keys(PRESETS.potrace).join(', '));

console.log('\n=== v5.3 默认基线（双图实测确定，不得随意回退）===');
ok(JSON.stringify(Object.keys(PRESETS.vtracer)) === JSON.stringify(['logo', 'photo', 'line', 'poster', 'pixel', 'vmde']),
  'vtracer 预设 = logo/photo/line/poster/pixel/vmde');
ok(SCHEMA.vtracer.find(d => d.key === 'filterSpeckle').def === 8, '主面板「去噪」默认值 = 8（不得改回 14）');
ok(collect('vtracer', 'logo').filterSpeckle === 8, 'logo 使用去噪 8');
ok(collect('vtracer', 'logo').hierarchical === 'cutout', 'logo 使用 cutout（实测优于 stacked）');
ok(collect('vtracer', 'logo').simplify === 1, 'logo 使用 simplify 1（平滑来源，v5.4 恢复）');
ok(collect('vtracer', 'vmde').filterSpeckle === 6, 'vmde（最高保真）使用去噪 6');
ok(collect('vtracer', 'vmde').hierarchical === 'cutout', 'vmde 使用 cutout');
ok(collect('vtracer', 'vmde').simplify === 1, 'vmde 使用 simplify 1');
ok(collect('vtracer', 'photo').hierarchical === 'cutout', 'photo 使用 cutout');
ok(collect('vtracer', 'line').simplify === undefined && collect('vtracer', 'line').hierarchical === 'stacked', 'line 仍为 stacked 且无 simplify');
ok(collect('vtracer', 'pixel').simplify === undefined && collect('vtracer', 'pixel').hierarchical === 'stacked', 'pixel 仍为 stacked 且无 simplify');
ok(collect('vtracer', 'poster').simplify === 1.5, 'poster 保持 simplify = 1.5（"少节点"取向）');

const advSimplify = ADV.vtracer.find(d => d.key === 'simplify');
ok(advSimplify && advSimplify.def === 0, 'ADV simplify 默认值 = 0');

console.log('\n=== 下发守卫 ===');
ok(collect('vtracer', 'logo').watershedDetail === undefined, '非分水岭档不下发 watershedDetail');
ok(collect('vtracer', 'logo').optimize === undefined, 'optimize = 0 时不下发');
ok(ADV.vtracer.some(d => d.key === 'watershedDetail' && d.def === 128), 'ADV watershedDetail 存在（默认 128）');

console.log('\n=== 版本一致性（防止文档版本号漂移）===');
{ const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const cl = fs.readFileSync(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  const heads = [...cl.matchAll(/^## \[(\d+\.\d+)\]/gm)].map(m => m[1]);
  ok(heads.length > 0 && heads[0] === pkg, 'CHANGELOG 最新条目 [' + (heads[0] || '-') + '] == package.json ' + pkg);
  /* 只检查**标题行**的小数位数（正文里的示例、历史记录、SVG 路径坐标不算） */
  const docs = ['docs/CHANGELOG.md', 'docs/PLAN_HIGH_FIDELITY.md', 'docs/PLAN_PARALLEL_ENGINE.md',
    'docs/PLAN_JOINT_OPTIMIZATION.md', 'docs/COMPARISON_DESKTOP_VS_WEB.md'];
  const bad = [];
  for (const d of docs) {
    const fp = path.join(root, d);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    for (const m of txt.matchAll(/^#{2,3} \[?v?(\d+)\.(\d+)\]?/gm)) if (m[2].length > 1) bad.push(d + ' → ' + m[0].trim());
  }
  ok(bad.length === 0, '所有文档的版本**标题**均为一维小数' + (bad.length ? '（违规: ' + bad.join(' | ') + '）' : ''));
}

console.log('\n=== 切换预设必须清结果缓存 ===');
ok(/S1\.preset = id;[\s\S]{0,120}S1\.lastKey = ''/.test(src), "预设点击处理里有 S1.lastKey = ''");

console.log('\n=== UI 契约（index.html 元素必须存在）===');
for (const id of ['preRes', 'preSize', 'preDenoise', 'preSmooth', 'preColors']) {
  ok(html.includes('id="' + id + '"'), '#' + id + ' 存在');
}
ok(!html.includes('id="preUpsample"'), '旧「小图自动上采样」复选框不得残留');

console.log('\n=== 观感指标方向验证（纪律：指标先验方向再用）===');
{ /* perceptual.js 的三个指标必须保持方向正确；一旦被改坏，立即拦下 */
  const r = require('child_process').spawnSync(process.execPath,
    [path.join(root, 'scripts/_verify-perceptual.mjs')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n').filter(l => l.includes('✓') || l.includes('✗'));
  for (const l of lines) ok(l.includes('✓'), l.replace(/^\s*[✓✗]\s*/, ''));
  if (r.status !== 0) ok(false, 'perceptual 方向验证脚本非零退出（stdout 见上）');
  /* perceptual.js 是测量模块，生产管线不引用 → 不得被打进线上包 */
  const build = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
  ok(/DEV_ONLY[\s\S]{0,120}perceptual\.js/.test(build), 'perceptual.js 已列入 DEV_ONLY（不进线上包）');
}

console.log('\n' + (fail ? `✗ 失败 ${fail} 项` : '✓ 全部通过'));
process.exit(fail ? 1 : 0);
