#!/usr/bin/env node
/* 回归守护：从 app.js 提取 PRESETS / SCHEMA / ADV 常量并断言关键默认值不被误改，
   同时校验 index.html 与 app.js 的 UI 契约（元素 id 必须存在）。
   用法：npm test */

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

console.log('\n=== 默认行为守护（v4.3 五档不得被改变）===');
ok(JSON.stringify(Object.keys(PRESETS.vtracer)) === JSON.stringify(['logo', 'photo', 'line', 'poster', 'pixel', 'vmde']),
  'vtracer 预设 = v4.3 的 5 档 + 唯一实验档 vmde');
ok(collect('vtracer', 'logo').hierarchical === 'stacked', 'logo 仍为 stacked');
ok(collect('vtracer', 'logo').simplify === undefined, 'logo 的 simplify 为 off（= v4.3 行为）');
ok(collect('vtracer', 'line').simplify === undefined, 'line 的 simplify 为 off');
ok(collect('vtracer', 'pixel').simplify === undefined, 'pixel 的 simplify 为 off');
ok(collect('vtracer', 'poster').simplify === 1.5, 'poster 保持 simplify = 1.5');

const advSimplify = ADV.vtracer.find(d => d.key === 'simplify');
ok(advSimplify && advSimplify.def === 0, 'ADV simplify 默认值 = 0（不得改回 1）');

console.log('\n=== vmde 档 ===');
ok(collect('vtracer', 'vmde').hierarchical === 'cutout', 'vmde 使用 cutout（无缝共用边界）');
ok(collect('vtracer', 'vmde').simplify === 1, 'vmde 使用 simplify = 1');

console.log('\n=== 下发守卫 ===');
ok(collect('vtracer', 'logo').watershedDetail === undefined, '非分水岭档不下发 watershedDetail');
ok(collect('vtracer', 'logo').optimize === undefined, 'optimize = 0 时不下发');
ok(ADV.vtracer.some(d => d.key === 'watershedDetail' && d.def === 128), 'ADV watershedDetail 存在（默认 128）');

console.log('\n=== UI 契约（index.html 元素必须存在）===');
for (const id of ['preRes', 'preSize', 'preDenoise', 'preSmooth', 'preColors', 'preUpsample']) {
  const present = html.includes('id="' + id + '"');
  if (id === 'preUpsample') ok(!present, '「小图自动上采样」复选框已由「描摹分辨率」下拉取代（不应残留）');
  else ok(present, '#' + id + ' 存在');
}
ok(PRESETS && SCHEMA && ADV, 'PRESETS/SCHEMA/ADV 均可解析');

console.log('\n' + (fail ? `✗ 失败 ${fail} 项` : '✓ 全部通过'));
process.exit(fail ? 1 : 0);
