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
ok(JSON.stringify(Object.keys(PRESETS.vtracer)) === JSON.stringify(['logo', 'detail', 'photo', 'line', 'poster', 'pixel', 'vmde']),
  'vtracer 预设 = logo/detail/photo/line/poster/pixel/vmde');

/* v6.8b 实测（VM 对照 + 局部放大肉眼核对）发现 filterSpeckle=8 会丢掉眼睛高光与鼻孔，
   故新增 detail 档（filterSpeckle=4 + simplify=0）—— 但**既有档位一律不动**（用户决定两个都留）。 */
ok(collect('vtracer', 'detail').filterSpeckle === 4, 'detail 使用去噪 4（实测保留眼睛高光/鼻孔）');
/* collectOptions 会 delete 掉 falsy 的 simplify；VTracer 官方语义为 "omit = off"，
   故 undefined 与 simplify:0 等价（都已实测：命令数 2746，细节保留）。 */
ok(collect('vtracer', 'detail').simplify === undefined, 'detail 不下发 simplify（= 不简化，官方 omit=off）');
ok(collect('vtracer', 'detail').hierarchical === 'cutout', 'detail 使用 cutout');
/* v7.1 参数寻优实测（用户追问"模版和参数都是最优了吗？"后做的全档位 + 单变量 + 组合扫描）：
   去噪 8→10 / 层差 16→32 / 路径精度 2→1，三项可叠加 → PSNR 36.53→37.05、体积 78.6→39.6KB。
   验收条件含**逐区域 MSE 不得上升**（防"PSNR 涨了但细节被丢"）——实测眼睛高光区 64.5→59.4。 */
ok(collect('vtracer', 'logo').filterSpeckle === 10, 'logo 使用去噪 10（v7.1 实测最优，+0.22dB 且体积更小）');
ok(collect('vtracer', 'logo').layerDifference === 32, 'logo 使用层差 32（v7.1 实测最优，+0.38dB，最优区间 28~32）');
ok(collect('vtracer', 'logo').pathPrecision === 1, 'logo 使用路径精度 1（PSNR 持平、体积 -15%）');
/* 扫描证明确为最优、必须保持不变的项（回退即等于放弃实测结论） */
ok(collect('vtracer', 'logo').cornerThreshold === 60, 'logo 拐角 60 实测最优（30~110 全在 ±0.25dB 内，60 为峰）');
ok(collect('vtracer', 'logo').colorPrecision === 6, 'logo 颜色精度 6 实测最优（4 灾难性 22.55dB / 8 降至 35.24）');
ok(collect('vtracer', 'logo').lengthThreshold === 4, 'logo 细节保留 4（实测 8 反而变差，保持 4）');
ok(collect('vtracer', 'vmde').pathPrecision === 1, 'vmde 路径精度 1（与 logo 同族，无条件更优）');
ok(SCHEMA.vtracer.find(d => d.key === 'filterSpeckle').def === 10, '面板「去噪」兜底默认 = 10（与 logo 档对齐实测最优）');
ok(SCHEMA.vtracer.find(d => d.key === 'layerDifference').def === 32, '面板「层间差异」兜底默认 = 32（与 logo 档对齐实测最优）');
ok(ADV.vtracer.find(d => d.key === 'pathPrecision').def === 1, 'ADV 路径精度兜底默认 = 1');
ok(collect('vtracer', 'logo').hierarchical === 'cutout', 'logo 使用 cutout（实测优于 stacked）');
ok(collect('vtracer', 'logo').simplify === 1, 'logo 使用 simplify 1（体积不设约束后仍保留：+0.58dB 需体积 ×2.9，取舍见 CHANGELOG 7.1）');
ok(collect('vtracer', 'vmde').filterSpeckle === 6, 'vmde（最高保真）使用去噪 6');
ok(collect('vtracer', 'vmde').hierarchical === 'cutout', 'vmde 使用 cutout');
ok(collect('vtracer', 'vmde').simplify === 1, 'vmde 使用 simplify 1');
ok(collect('vtracer', 'photo').hierarchical === 'cutout', 'photo 使用 cutout');
ok(collect('vtracer', 'line').simplify === undefined && collect('vtracer', 'line').hierarchical === 'stacked', 'line 仍为 stacked 且无 simplify');
ok(collect('vtracer', 'pixel').simplify === undefined && collect('vtracer', 'pixel').hierarchical === 'stacked', 'pixel 仍为 stacked 且无 simplify');
ok(collect('vtracer', 'poster').simplify === 1.5, 'poster 保持 simplify = 1.5（"少节点"取向）');

console.log('\n=== v7.1 模板健壮性（两处实测发现的缺陷）===');
{
  /* 直接在源码上按"每个模板块"切分并检字段 —— 不做 JSON.parse（源码含注释与单引号，反序列化不可靠） */
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const m = src.match(/const TEMPLATES = \[[\s\S]*?\n\];/);
  ok(!!m, '能找到 TEMPLATES 定义');
  if (m) {
    const body = m[0];
    /* 切块：以 "id: 'xxx'" 为界 */
    const blocks = body.split(/(?=\bid:\s*'[^']*'\s*,)/).slice(1);
    ok(blocks.length === 8, `TEMPLATES 共 8 条（实得 ${blocks.length}）`);
    const ids = [], noHier = [], noClu = [], cutoutEdge = [];
    for (const b of blocks) {
      const id = (b.match(/\bid:\s*'([^']*)'/) || [])[1] || '?';
      ids.push(id);
      /* adv 块 =从 "adv: {" 到其匹配的 "}" */
      const advM = b.match(/adv:\s*\{([\s\S]*?)\}/);
      const adv = advM ? advM[1] : '';
      const postM = b.match(/post:\s*\{([\s\S]*?)\}/);
      const post = postM ? postM[1] : '';
      if (!/hierarchical:\s*'/.test(adv)) noHier.push(id);
      if (!/clustering:\s*'/.test(adv)) noClu.push(id);
      if (/hierarchical:\s*'cutout'/.test(adv) && /edge:\s*[1-9]/.test(post)) cutoutEdge.push(id);
    }
    /* 缺陷①：adv 缺 hierarchical / clustering → 会沿用上一次的选择，同模板结果不可复现 */
    ok(noHier.length === 0, `每个模板都显式声明 adv.hierarchical（缺失会让层级模式残留：${noHier.join(',') || '无'}）`);
    ok(noClu.length === 0, `每个模板都显式声明 adv.clustering（缺失会让分区算法残留：${noClu.join(',') || '无'}）`);
    /* 缺陷②：cutout 模板写 post.edge 是死配置（cutout 已强制跳过几何后处理） */
    ok(cutoutEdge.length === 0, `cutout 模板不应写 post.edge（cutout 下已跳过几何后处理）：${cutoutEdge.join(',') || '无'}`);
    ok(/setCtlValue\('#smoothEdge', tpl\.post\.edge \|\| 0/.test(src), 'applyTemplate 对未写 edge 的模板显式置 0，杜绝滑块残留');
    ok(ids.includes('line') && !noHier.includes('line'), 'line 模板存在且已声明层级模式');

    /* v7.1.1 模板参数实测寻优：钉死 5 个实测获益模板的层差/去噪；
       lean/tiny 有意保持（体积优先档，实测层差 32 收益≈0 甚至区域变差） */
    const pOf = id => { const b = blocks.find(x => (x.match(/\bid:\s*'([^']*)'/) || [])[1] === id);
      const pm = b.match(/params:\s*\{([\s\S]*?)\}/); return pm ? pm[1] : ''; };
    const EXPECT_TPL = {
      daily:    { filterSpeckle: 10, layerDifference: 32 },
      artwork:  { filterSpeckle: 6,  layerDifference: 32 },
      smooth:   { filterSpeckle: 10, layerDifference: 32 },
      faithful: { filterSpeckle: 4,  layerDifference: 24 },
      photo:    { filterSpeckle: 10, layerDifference: 32 },
      lean:     { filterSpeckle: 14, layerDifference: 16 },
      tiny:     { filterSpeckle: 16, layerDifference: 20 },
      line:     { filterSpeckle: 2,  layerDifference: 16 },
    };
    for (const id in EXPECT_TPL) {
      const p = pOf(id), e = EXPECT_TPL[id];
      ok(new RegExp(`filterSpeckle:\\s*${e.filterSpeckle}\\b`).test(p) && new RegExp(`layerDifference:\\s*${e.layerDifference}\\b`).test(p),
        `模板 ${id} 参数 = 去噪${e.filterSpeckle}/层差${e.layerDifference}`);
    }
  }
}

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
