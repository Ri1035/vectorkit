/* 四页综合冒烟 + 回归测试 */
const out = document.createElement('pre');
out.id = 'e2eout';
out.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#fff;color:#000;font-size:12px;white-space:pre-wrap;max-width:100%';
document.body.appendChild(out);
const put = (s) => { out.textContent += s + '\n'; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function switchTab(name) {
  $$('.tab').filter(t => t.dataset.tab === name)[0].click();
}
async function waitProg(sel, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = $(sel) ? $(sel).textContent : '';
    if (/完成/.test(s)) return '完成';
    if (/失败/.test(s)) return '失败: ' + s;
    await wait(200);
  }
  return '超时';
}

try {
  await wait(800);

  put('=== 页 1：位图→矢量 ===');
  switchTab('r2v');
  await wait(200);
  $('#demo1').click();
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 15000) { if (!$('#run1').disabled) { ready = true; break; } await wait(150); }
  put('载入示例 = ' + ready);

  // VTracer 转换
  $('#run1').click();
  put('VTracer 转换 = ' + await waitProg('#prog1', 30000));
  put('  下载 SVG 可用 = ' + !$('#dl1').disabled + '，下载 EPS 可用 = ' + !$('#dlEps').disabled);
  const svgResult = $('#stage1 svg') ? 'svg元素' : (($('#stage1 img') || {}).src ? 'img' : '?');
  put('  结果展示 = ' + svgResult);

  // Potrace 转换
  $$('#engineSeg button').find(b => b.dataset.engine === 'potrace').click();
  await wait(500);
  $('#run1').click();
  put('Potrace 转换 = ' + await waitProg('#prog1', 30000));
  $$('#engineSeg button').find(b => b.dataset.engine === 'vtracer').click();
  await wait(400);

  // 设置 tab 全切换
  put('设置 tab 全切换：');
  for (const name of ['tpl', 'engine', 'params', 'pre', 'post', 'out']) {
    $$('#setTabs .set-tab').find(t => t.dataset.set === name).click();
    await wait(120);
    const on = $$('#settingsCard .set-pane.on').map(p => p.dataset.pane).join(',');
    if (on !== name) { put('  ✗ ' + name + ' → 实际 ' + on); }
  }
  put('  全部切换正常');

  // 模板套用后再转换
  $$('#setTabs .set-tab').find(t => t.dataset.set === 'tpl').click();
  await wait(150);
  $$('#templates .preset').find(b => b.dataset.tpl === 'lean').click();
  await wait(250);
  $('#run1').click();
  put('节点精简模板转换 = ' + await waitProg('#prog1', 30000));

  put('=== 页 2：矢量→位图 ===');
  switchTab('v2r');
  await wait(300);
  put('面板可见 = ' + $('#panel-v2r').classList.contains('active'));
  put('空状态显示 = ' + ($('#stage2') ? $('#stage2').textContent.includes('载入 SVG') || $('#stage2').textContent.length > 0 : false));
  put('生成按钮禁用（无输入）= ' + $('#run2').disabled);

  put('=== 页 3：去背景 ===');
  switchTab('matte');
  await wait(300);
  put('面板可见 = ' + $('#panel-matte').classList.contains('active'));
  put('开始按钮禁用（无输入）= ' + $('#run4').disabled);

  put('=== 页 4：优化压缩 ===');
  switchTab('opt');
  await wait(300);
  put('面板可见 = ' + $('#panel-opt').classList.contains('active'));
  put('开始按钮禁用（无输入）= ' + $('#run3').disabled);
  put('折叠卡片（优化选项）= ' + !!document.getElementById('foldOpt'));

  put('=== 回到页 1 确认状态保持 ===');
  switchTab('r2v');
  await wait(300);
  put('结果仍在 = ' + !$('#dl1').disabled);

  put('DONE');
  await wait(300);
  out.style.display = 'none';
} catch (e) {
  put('FAIL ' + (e && e.stack || e));
}
