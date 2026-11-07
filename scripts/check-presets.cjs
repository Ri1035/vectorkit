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
  /* v8.0：模板改为「部分引用预设」后，正则切块不再可靠 → 直接求值 TEMPLATES，
     断言解析后的真实对象（比正则更贴近运行时行为）。 */
  const src2 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const tplM = src2.match(/const TEMPLATES = \[[\s\S]*?\n\];/);
  ok(!!tplM, '能找到 TEMPLATES 定义');
  if (tplM) {
    const helpers = (src2.match(/function presetParams\(id\)[\s\S]*?function presetAdv\(id\)[\s\S]*?\n\}/) || [''])[0];
    ok(!!helpers, '模板参数同源辅助函数 presetParams / presetAdv 存在');
    const box = {};
    new Function('exports',
      [slice('const PRESETS = {', 'const SCHEMA = {'), helpers, tplM[0],
       'exports.TEMPLATES=TEMPLATES;exports.PRESETS=PRESETS;'].join('\n'))(box);
    const { TEMPLATES: T, PRESETS: P } = box;
    const ids = T.map(t => t.id);
    ok(T.length === 8, `TEMPLATES 共 8 条（实得 ${T.length}）`);
    ok(JSON.stringify(ids) === JSON.stringify(['daily', 'lean', 'artwork', 'smooth', 'tiny', 'faithful', 'photo', 'line']),
      '模板 id 与顺序未变：' + ids.join(','));

    /* 缺陷①：adv 必须解析出 clustering / hierarchical（否则会沿用上一次的选择） */
    const noHier = T.filter(t => !t.adv || !t.adv.hierarchical).map(t => t.id);
    const noClu = T.filter(t => !t.adv || !t.adv.clustering).map(t => t.id);
    ok(noHier.length === 0, `每个模板都解析出 adv.hierarchical（缺失：${noHier.join(',') || '无'}）`);
    ok(noClu.length === 0, `每个模板都解析出 adv.clustering（缺失：${noClu.join(',') || '无'}）`);
    /* 缺陷②：cutout 模板写 post.edge 是死配置 */
    const cutoutEdge = T.filter(t => t.adv.hierarchical === 'cutout' && t.post && t.post.edge > 0).map(t => t.id);
    ok(cutoutEdge.length === 0, `cutout 模板不应写 post.edge（实得：${cutoutEdge.join(',') || '无'}）`);
    ok(/setCtlValue\('#smoothEdge', tpl\.post\.edge \|\| 0/.test(src2), 'applyTemplate 对未写 edge 的模板显式置 0，杜绝滑块残留');

    /* 实测数值：钉死每个模板实际生效的参数（引用预设的模板同样要等于该值） */
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
    for (const id of Object.keys(EXPECT_TPL)) {
      const t = T.find(x => x.id === id) || { params: {} };
      const e = EXPECT_TPL[id];
      ok(t.params.filterSpeckle === e.filterSpeckle && t.params.layerDifference === e.layerDifference,
        `模板 ${id} 生效参数 = 去噪${t.params.filterSpeckle}/层差${t.params.layerDifference}（期望 ${e.filterSpeckle}/${e.layerDifference}）`);
    }

    /* v8.0 新增：与预设同源的模板必须**始终**等于该预设（改预设不会让模板落后） */
    const logo = P.vtracer.logo.opts;
    const synced = ['daily', 'smooth', 'photo'];
    for (const id of synced) {
      const t = T.find(x => x.id === id);
      ok(t.params.filterSpeckle === logo.filterSpeckle
        && t.params.layerDifference === logo.layerDifference
        && t.params.cornerThreshold === logo.cornerThreshold
        && t.params.lengthThreshold === logo.lengthThreshold,
        `模板 ${id} 与 logo 预设同源（去噪/层差/拐角/细节四项一致）`);
    }
    const art = T.find(x => x.id === 'artwork');
    ok(art.params.filterSpeckle === 6 && art.params.layerDifference === logo.layerDifference,
      'artwork 仅去噪有意不同（6），其余与 logo 同源');
    const lean = T.find(x => x.id === 'lean');
    ok(lean.params.filterSpeckle === 14 && lean.params.layerDifference === 16,
      'lean 有意保持 14/16（体积优先档，不跟随 logo）');
    const tiny = T.find(x => x.id === 'tiny');
    ok(tiny.params.filterSpeckle === 16 && tiny.params.layerDifference === 20,
      'tiny 有意保持 16/20（v7.2 实测层差 32 零收益）');
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
    [path.join(root, 'scripts/verify-perceptual.mjs')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n').filter(l => l.includes('✓') || l.includes('✗'));
  for (const l of lines) ok(l.includes('✓'), l.replace(/^\s*[✓✗]\s*/, ''));
  if (r.status !== 0) ok(false, 'perceptual 方向验证脚本非零退出（stdout 见上）');
  /* perceptual.js 是测量模块，生产管线不引用 → 不得被打进线上包 */
  const build = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
  ok(/DEV_ONLY[\s\S]{0,160}perceptual\.js/.test(build), 'perceptual.js 已列入 DEV_ONLY（不进线上包）');
  /* v7.7：ssimEdge 的均值与二阶矩必须同窗 —— 混窗会破坏柯西-施瓦茨，
     方差算出负数，局部 SSIM 可到 195412（实测均值 1.97）。 */
  const pj = fs.readFileSync(path.join(root, 'perceptual.js'), 'utf8');
  ok(/const maa = gaussBlur\(saa/.test(pj) && !/boxBlur\(s[abc][ab]/.test(pj),
    'ssimEdge 均值与二阶矩同窗（二阶矩不得用盒式模糊）');
  ok(!/function boxBlur/.test(pj), 'perceptual.js 不再保留盒式模糊（避免被误用为异窗口）');
}

console.log('\n=== 卡死防护（2026-11-07 审查）===');
{
  /* ① 引擎加载必须有超时：loadEngine 自身不设超时，弱网/代理挂起时会永久 await */
  const vec = (src.match(/async function vectorize\(opts\)[\s\S]*?\n\}/) || [''])[0];
  const svg = (src.match(/async function svgoOptimize\(svg, config\)[\s\S]*?\n\}/) || [''])[0];
  ok(/loadEngineWithTimeout/.test(vec) && !/[^h]await loadEngine\(/.test(vec),
    'vectorize 走带超时的加载（超出即报错并可重试）');
  ok(/loadEngineWithTimeout/.test(svg), 'svgoOptimize 走带超时的加载');
  ok(/async function loadEngineWithTimeout/.test(src), 'loadEngineWithTimeout 存在（超时后清缓存槽）');

  /* ② Paper.js 的 script 标签加载必须有超时 */
  const mp = fs.readFileSync(path.join(root, 'merge-paths.js'), 'utf8');
  ok(/PAPER_LOAD_TIMEOUT/.test(mp) && /setTimeout\(\(\) => fail\(/.test(mp),
    'loadPaper 带超时并在超时后清空缓存');

  /* ③ 转换不可并发重入（模板点击会在转换中再排一次） */
  ok(/vectorRunActive/.test(src) && /vectorRunPending/.test(src),
    'runVectorize 有重入保护与挂起补跑');
}

console.log('\n' + (fail ? `✗ 失败 ${fail} 项` : '✓ 全部通过'));
process.exit(fail ? 1 : 0);
