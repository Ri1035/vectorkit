import * as PotraceLib from './vendor/potrace.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const MAX_SIDE = 1600;

/* ============================ 引擎初始化 ============================ */

let potraceReady = false;
let vtracerMod = null;

async function initEngines() {
  const loadVtracer = (async () => {
    try {
      vtracerMod = await import('./vendor/vtracer.js');
      return !!vtracerMod.vectorize_rgba;
    } catch (err) {
      console.warn('[vtracer] 加载失败', err);
      return false;
    }
  })();

  const loadPotrace = (async () => {
    try {
      if (typeof PotraceLib.init === 'function') await PotraceLib.init();
      potraceReady = true;
      return true;
    } catch (err) {
      console.warn('[potrace] 初始化失败', err);
      return false;
    }
  })();

  const [vt, pt] = await Promise.all([loadVtracer, loadPotrace]);

  const chip = $('#engineChip');
  chip.classList.add('ready');
  const names = [];
  if (vt) names.push('VTracer');
  if (pt) names.push('Potrace');
  $('#engineText').textContent = names.length
    ? `引擎就绪 · ${names.join(' + ')}`
    : '引擎加载失败';

  if (!vt) {
    const b = $('#engineSeg button[data-engine="vtracer"]');
    if (b) { b.disabled = true; b.style.opacity = '.4'; }
  }
  if (!pt) {
    const b = $('#engineSeg button[data-engine="potrace"]');
    if (b) { b.disabled = true; b.style.opacity = '.4'; }
    if (S1.engine === 'potrace') {
      S1.engine = 'vtracer';
      S1.preset = 'logo';
      $$('#engineSeg button').forEach(x => x.classList.toggle('on', x.dataset.engine === 'vtracer'));
      renderPresets();
      renderParams();
    }
  }
  if (!vt) names.length = 0;
}

/* ============================ 通用工具 ============================ */

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function makeUrl(prev, payload, mime) {
  if (prev && typeof prev === 'string' && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
  const blob = mime ? new Blob([payload], { type: mime }) : payload;
  return URL.createObjectURL(blob);
}

function revokeIfBlob(u) {
  if (u && typeof u === 'string' && u.startsWith('blob:')) URL.revokeObjectURL(u);
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function ensureSvgSize(svgText, w, h) {
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return svgText;
    const el = doc.documentElement;
    if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!el.getAttribute('viewBox')) el.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (!el.getAttribute('width')) el.setAttribute('width', String(w));
    if (!el.getAttribute('height')) el.setAttribute('height', String(h));
    return new XMLSerializer().serializeToString(el);
  } catch {
    return svgText;
  }
}

async function readSvgFile(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(buf);
}

async function gzipBlob(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'image/svg+xml' });
}

function fileTag(host, file, onRemove) {
  host.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'filetag';
  row.innerHTML = `<span class="nm"></span><span class="sz"></span><button class="rm" title="移除">×</button>`;
  $('.nm', row).textContent = file.name;
  $('.sz', row).textContent = fmtBytes(file.size);
  $('.rm', row).addEventListener('click', onRemove);
  host.appendChild(row);
}

function wireDrop(dropEl, inputHandler) {
  const pick = document.createElement('input');
  pick.type = 'file';
  pick.style.display = 'none';
  document.body.appendChild(pick);

  dropEl.addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => { if (pick.files[0]) inputHandler(pick.files[0]); pick.value = ''; });

  ['dragenter', 'dragover'].forEach(ev =>
    dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('over'); }));
  dropEl.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) inputHandler(f);
  });
  return pick;
}

function statCard(items) {
  const wrap = document.createElement('div');
  wrap.className = 'stats';
  wrap.innerHTML = items.map(([k, v, u]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div></div>`
  ).join('');
  return wrap;
}

/* ============================ Tab 切换 ============================ */

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.tab));
  });
});

/* ============================ 预设与参数定义 ============================ */

const PRESETS = {
  vtracer: {
    logo:   { name: 'Logo 图标', desc: '扁平色块，边界锐利', opts: { clustering: 'color-cluster', hierarchical: 'cutout', filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    photo:  { name: '照片', desc: '连续色调，保留细节', opts: { preset: 'photo', filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 1, hierarchical: 'stacked' } },
    line:   { name: '线稿 / 签名', desc: '黑白线条与轮廓', opts: { clustering: 'bw', adaptive: true, filterSpeckle: 2, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    poster: { name: '海报扁平', desc: '自动减色，体积更小', opts: { preset: 'poster', maxColors: 12, hierarchical: 'cutout', simplify: 1.5, optimize: 2, filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    pixel:  { name: '像素画', desc: '保留硬边方格', opts: { clustering: 'color-cluster', mode: 'pixel', filterSpeckle: 0, colorPrecision: 8, maxIterations: 0, pathPrecision: 0 } }
  },
  potrace: {
    sharp:  { name: '锐利线条', desc: '拐角保留，几何图形', opts: { turdsize: 2, alphamax: 0, opticurve: 1, opttolerance: 0.2, extractcolors: 0, posterizelevel: 2, turnpolicy: 4 } },
    smooth: { name: '圆润曲线', desc: '平滑，适合手绘', opts: { turdsize: 4, alphamax: 1.334, opticurve: 1, opttolerance: 0.4, extractcolors: 0, posterizelevel: 2, turnpolicy: 4 } },
    clean:  { name: '强去噪', desc: '忽略零碎斑点', opts: { turdsize: 16, alphamax: 1, opticurve: 1, opttolerance: 0.3, extractcolors: 0, posterizelevel: 2, turnpolicy: 4 } },
    poster: { name: '海报分层', desc: '多色调分色输出', opts: { turdsize: 2, alphamax: 1, opticurve: 1, opttolerance: 0.2, extractcolors: 1, posterizelevel: 4, posterizationalgorithm: 1, turnpolicy: 4 } }
  }
};

const SCHEMA = {
  vtracer: [
    { key: 'filterSpeckle', label: '去噪（忽略小色块）', min: 0, max: 32, step: 1, def: 4 },
    { key: 'maxColors', label: '最大色数（0 为不限）', min: 0, max: 64, step: 1, def: 0 },
    { key: 'cornerThreshold', label: '拐角阈值', min: 0, max: 180, step: 1, def: 60 },
    { key: 'lengthThreshold', label: '细节保留度', min: 0, max: 20, step: 1, def: 4 }
  ],
  potrace: [
    { key: 'turdsize', label: '去噪（忽略斑点）', min: 0, max: 32, step: 1, def: 2 },
    { key: 'alphamax', label: '拐角平滑', min: 0, max: 1.334, step: 0.001, def: 1 },
    { key: 'opttolerance', label: '曲线容差', min: 0, max: 1, step: 0.01, def: 0.2 },
    { key: 'posterizelevel', label: '色调分层数', min: 1, max: 16, step: 1, def: 8 }
  ]
};

const ADV = {
  vtracer: [
    { key: 'clustering', label: '分区算法', type: 'select', options: [['color-cluster', '色彩聚类（通用）'], ['bw', '黑白二值'], ['watershed', '分水岭']] },
    { key: 'hierarchical', label: '层级模式', type: 'select', options: [['stacked', '堆叠'], ['cutout', '镂空（无接缝）']] },
    { key: 'mode', label: '曲线模式', type: 'select', options: [['spline', '平滑样条'], ['polygon', '多边形'], ['pixel', '像素不简化']] },
    { key: 'simplify', label: '曲线简化容差（0 关闭）', type: 'range', min: 0, max: 5, step: 0.5, def: 0 },
    { key: 'colorPrecision', label: '颜色精度', type: 'range', min: 1, max: 8, step: 1, def: 6 },
    { key: 'pathPrecision', label: '路径精度', type: 'range', min: 0, max: 8, step: 1, def: 2 }
  ],
  potrace: [
    { key: 'turnpolicy', label: '拐角策略', type: 'select', options: [['4', '少数派（推荐）'], ['0', '黑色优先'], ['1', '白色优先'], ['5', '多数派']] },
    { key: 'opticurve', label: '曲线优化', type: 'select', options: [['1', '开启'], ['0', '关闭']] },
    { key: 'extractcolors', label: '彩色分层', type: 'select', options: [['0', '关闭（纯黑白）'], ['1', '开启（海报化）']] }
  ]
};

/* ============================ Tab1 · 位图转矢量 ============================ */

const S1 = {
  bitmap: null, file: null, imageData: null, srcUrl: '',
  engine: 'vtracer', preset: 'logo',
  svg: '', svgUrl: '', outBlob: null, outName: '', w: 0, h: 0
};

function renderPresets() {
  const host = $('#presets');
  host.innerHTML = '';
  Object.entries(PRESETS[S1.engine]).forEach(([id, p]) => {
    const b = document.createElement('button');
    b.className = 'preset' + (id === S1.preset ? ' on' : '');
    b.innerHTML = `<span class="p1"></span><span class="p2"></span>`;
    $('.p1', b).textContent = p.name;
    $('.p2', b).textContent = p.desc;
    b.addEventListener('click', () => {
      S1.preset = id;
      renderPresets();
      renderParams();
    });
    host.appendChild(b);
  });
}

function renderParams() {
  const opts = PRESETS[S1.engine][S1.preset].opts;
  const host = $('#params');
  host.innerHTML = '';

  SCHEMA[S1.engine].forEach(def => {
    const row = document.createElement('div');
    row.className = 'row';
    const val = opts[def.key] !== undefined ? opts[def.key] : (def.def !== undefined ? def.def : def.min);
    row.innerHTML = `<label></label><input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}"><output></output>`;
    $('label', row).textContent = def.label;
    const out = $('output', row);
    out.textContent = val;
    $('input', row).addEventListener('input', e => { out.textContent = e.target.value; });
    host.appendChild(row);
  });

  const advHost = $('#advBox');
  advHost.innerHTML = '';
  ADV[S1.engine].forEach(def => {
    const row = document.createElement('div');
    row.className = 'row';
    const val = opts[def.key] !== undefined ? opts[def.key] : (def.type === 'select' ? def.options[0][0] : (def.def !== undefined ? def.def : def.min));
    if (def.type === 'select') {
      row.innerHTML = `<label></label><select>${def.options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
      $('select', row).value = String(val);
    } else {
      row.innerHTML = `<label></label><input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}"><output>${val}</output>`;
      const out = $('output', row);
      $('input', row).addEventListener('input', e => { out.textContent = e.target.value; });
    }
    $('label', row).textContent = def.label;
    advHost.appendChild(row);
  });
}

function collectOptions() {
  const base = Object.assign({}, PRESETS[S1.engine][S1.preset].opts);
  const rows = $$('#params .row');
  SCHEMA[S1.engine].forEach((def, i) => {
    const v = parseFloat($('input', rows[i]).value);
    base[def.key] = v;
  });
  const advRows = $$('#advBox .row');
  ADV[S1.engine].forEach((def, i) => {
    const el = $('select', advRows[i]) || $('input', advRows[i]);
    const raw = el.value;
    if (def.type === 'select') {
      base[def.key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else {
      base[def.key] = parseFloat(raw);
    }
  });
  if (S1.engine === 'vtracer') {
    if (!base.maxColors) delete base.maxColors;
    if (!base.simplify) delete base.simplify;
    if (base.clustering === 'bw') {
      delete base.colorPrecision;
      delete base.layerDifference;
      delete base.palette;
      delete base.maxColors;
    }
  } else if (!base.extractcolors) {
    delete base.posterizelevel;
    delete base.posterizationalgorithm;
  }
  return base;
}

async function loadRaster(file) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return { imageData: ctx.getImageData(0, 0, w, h), canvas: c, w, h, natural: { w: bmp.width, h: bmp.height } };
}

function setSourceImage(blobOrFile) {
  S1.srcUrl = makeUrl(S1.srcUrl, blobOrFile);
  renderStage1();
}

function renderStage1(statusText, statusSub) {
  const stage = $('#stage1');
  stage.innerHTML = '';
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `<div class="pane-head"><span>原图</span></div><div class="canvas-wrap"><img id="imgSrc" alt="原图"></div>`;
  const pane2 = document.createElement('div');
  pane2.className = 'pane';
  pane2.innerHTML = `<div class="pane-head"><span>矢量化结果</span><span class="hint">${statusText || '等待转换'}</span></div><div class="canvas-wrap"><div class="empty" style="padding:20px"><div class="sub">${statusSub || '点击左侧「开始转换」'}</div></div></div>`;
  stage.append(pane, pane2);
  $('#imgSrc').src = S1.srcUrl;
}

function showVectorResult(svgText, ms, dims) {
  const bytes = new Blob([svgText]).size;
  const paths = (svgText.match(/<path/gi) || []).length;
  const nodes = (svgText.match(/[MmLlCcSsQqTtAaZz]/g) || []).length;

  S1.svgUrl = makeUrl(S1.svgUrl, svgText, 'image/svg+xml');
  S1.svg = svgText;
  S1.outBlob = new Blob([svgText], { type: 'image/svg+xml' });

  const stage = $('#stage1');
  const pane2 = stage.children[1];
  const wrap = $('.canvas-wrap', pane2);
  $('.pane-head', pane2).innerHTML = `<span>矢量化结果</span><span class="hint">${ms.toFixed(0)} ms</span>`;
  wrap.innerHTML = `<img alt="矢量化结果">`;
  $('img', wrap).src = S1.svgUrl;

  const card = statCard([
    ['输出体积', fmtBytes(bytes)],
    ['路径数', paths],
    ['路径节点', nodes],
    ['耗时', ms.toFixed(0), 'ms']
  ]);
  card.id = 'stats1';
  const prev = $('#stats1');
  if (prev && prev.parentNode) prev.replaceWith(card);
  else $('#stage1').parentNode.appendChild(card);

  $('#dl1').disabled = false;
  $('#copy1').disabled = false;
}

async function runVectorize() {
  const btn = $('#run1');
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="busy"></span>转换中…';
  await new Promise(r => setTimeout(r, 30));

  const t0 = performance.now();
  try {
    const opts = collectOptions();
    const { w, h } = S1;
    let svgText;
    if (S1.engine === 'vtracer') {
      if (!vtracerMod) throw new Error('VTracer 引擎尚未就绪');
      const rgba = new Uint8Array(S1.imageData.data);
      svgText = vtracerMod.vectorize_rgba(rgba, w, h, opts);
    } else {
      svgText = await PotraceLib.potrace(S1.imageData, opts);
    }
    const ms = performance.now() - t0;
    svgText = ensureSvgSize(svgText, w, h);
    showVectorResult(svgText, ms, { w, h });
  } catch (err) {
    console.error(err);
    alert('转换失败：' + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

wireDrop($('#drop1'), async file => {
  try {
    const res = await loadRaster(file);
    S1.bitmap = res.canvas;
    S1.imageData = res.imageData;
    S1.w = res.w; S1.h = res.h;
    S1.file = file;
    S1.outName = stripExt(file.name) + '.svg';
    setSourceImage(file);
    $('#file1').innerHTML = '';
    fileTag($('#file1'), file, () => {
      S1.imageData = null; S1.srcUrl = ''; S1.svgUrl = '';
      $('#file1').innerHTML = '';
      $('#run1').disabled = true;
      $('#dl1').disabled = true;
      $('#copy1').disabled = true;
      $('#stats1').classList.add('hidden');
      $('#stage1').innerHTML = `<div class="empty"><div>载入一张图片后开始转换</div></div>`;
    });
    $('#run1').disabled = false;
  } catch (err) {
    alert('无法读取该图片：' + (err.message || err));
  }
});

$('#engineSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  S1.engine = b.dataset.engine;
  S1.preset = Object.keys(PRESETS[S1.engine])[0];
  $$('#engineSeg button').forEach(x => x.classList.toggle('on', x === b));
  renderPresets();
  renderParams();
});

$('#advToggle').addEventListener('click', () => {
  const t = $('#advToggle');
  t.classList.toggle('open');
  $('#advBox').classList.toggle('open');
});

$('#run1').addEventListener('click', runVectorize);

$('#dl1').addEventListener('click', () => {
  if (S1.outBlob) download(S1.outBlob, S1.outName || 'vector.svg');
});

$('#copy1').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(S1.svg);
    const b = $('#copy1'); const old = b.textContent;
    b.textContent = '已复制';
    setTimeout(() => { b.textContent = old; }, 1200);
  } catch { alert('浏览器拒绝了剪贴板访问'); }
});

/* ---------- 示例图 ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeDemo(kind) {
  const S = 480;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');

  if (kind === 'color') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#F97316';
    ctx.beginPath(); ctx.arc(170, 175, 100, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2563EB';
    roundRect(ctx, 245, 205, 155, 150, 26); ctx.fill();
    ctx.fillStyle = '#111827';
    ctx.beginPath(); ctx.moveTo(120, 400); ctx.lineTo(205, 265); ctx.lineTo(290, 400); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 16;
    ctx.beginPath(); ctx.arc(330, 120, 58, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#111111';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(50, 390);
    ctx.bezierCurveTo(120, 280, 150, 340, 215, 235);
    ctx.bezierCurveTo(275, 140, 330, 300, 425, 175);
    ctx.stroke();
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(355, 108, 46, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(70, 425);
    ctx.lineTo(410, 425);
    ctx.stroke();
  }
  return c;
}

$('#demo1').addEventListener('click', () => {
  const useColor = S1.engine !== 'potrace';
  const c = makeDemo(useColor ? 'color' : 'line');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  S1.imageData = ctx.getImageData(0, 0, c.width, c.height);
  S1.w = c.width; S1.h = c.height;
  S1.outName = 'demo-vector.svg';

  revokeIfBlob(S1.srcUrl);
  S1.srcUrl = c.toDataURL('image/png');
  renderStage1();

  const name = useColor ? 'demo-logo.png' : 'demo-sketch.png';
  S1.file = { name, size: Math.round(S1.srcUrl.length * 0.75) };
  fileTag($('#file1'), S1.file, () => {});
  $('#run1').disabled = false;
});

/* ============================ Tab2 · 矢量转位图 ============================ */

const S2 = { svgText: '', svgUrl: '', outUrl: '', file: null, w: 0, h: 0, out: null, ext: 'png' };

function parseSvgMeta(text) {
  let w = 0, h = 0;
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const el = doc.documentElement;
    const vb = (el.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
    if (!w) {
      w = parseFloat(el.getAttribute('width')) || 300;
      h = parseFloat(el.getAttribute('height')) || 150;
    }
  } catch { w = 300; h = 150; }
  return { w: Math.round(w), h: Math.round(h) };
}

async function loadSvgForRaster(file) {
  const text = await readSvgFile(file);
  if (!/<svg[\s>]/i.test(text)) throw new Error('这不是一个有效的 SVG 文件');
  const meta = parseSvgMeta(text);
  S2.svgText = text;
  S2.file = file;
  S2.w = meta.w; S2.h = meta.h;
  S2.svgUrl = makeUrl(S2.svgUrl, text, 'image/svg+xml');

  $('#stage2').innerHTML = `
    <div class="empty" style="padding:36px">
      <div class="sub" style="margin-bottom:14px">已载入 ${meta.w} × ${meta.h} · 选择右侧设置后生成位图</div>
      <img src="${S2.svgUrl}" style="max-width:100%;max-height:340px" alt="SVG 预览">
    </div>`;
  $('#run2').disabled = false;
  $('#dl2').disabled = true;
  $('#stats2').classList.add('hidden');
}

async function runRasterize() {
  const btn = $('#run2');
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="busy"></span>渲染中…';
  await new Promise(r => setTimeout(r, 30));

  const t0 = performance.now();
  try {
    const scale = parseFloat($('#outScale').value);
    const format = $('#outFormat').value;
    const quality = parseFloat($('#outQuality').value) / 100;
    let bg = $('#outBg').value;
    if (bg === 'custom') bg = $('#outBgColor').value;

    const img = new Image();
    img.src = S2.svgUrl;
    await img.decode();

    const w = Math.max(1, Math.round(S2.w * scale));
    const h = Math.max(1, Math.round(S2.h * scale));

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    } else if (format === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise(r => c.toBlob(r, format, quality));
    if (!blob) throw new Error('浏览器不支持该输出格式');
    const ms = performance.now() - t0;

    S2.out = blob;
    S2.ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';

    const stage = $('#stage2');
    stage.innerHTML = `
      <div class="pane">
        <div class="pane-head"><span>SVG 源</span><span class="hint">${S2.w} × ${S2.h}</span></div>
        <div class="canvas-wrap"><img alt="源 SVG"></div>
      </div>
      <div class="pane">
        <div class="pane-head"><span>渲染输出</span><span class="hint">${ms.toFixed(0)} ms</span></div>
        <div class="canvas-wrap"><img alt="输出位图"></div>
      </div>`;
    const imgs = $$('#stage2 img');
    imgs[0].src = S2.svgUrl;
    S2.outUrl = makeUrl(S2.outUrl, blob);
    imgs[1].src = S2.outUrl;

    const holder = $('#stats2');
    const card = statCard([
      ['输出尺寸', `${w} × ${h}`],
      ['输出体积', fmtBytes(blob.size)],
      ['格式', S2.ext.toUpperCase()],
      ['耗时', ms.toFixed(0), 'ms']
    ]);
    holder.replaceWith(card);
    card.id = 'stats2';
    card.classList.remove('hidden');
    $('#dl2').disabled = false;
  } catch (err) {
    console.error(err);
    alert('渲染失败：' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

wireDrop($('#drop2'), async file => {
  try {
    await loadSvgForRaster(file);
    $('#file2').innerHTML = '';
    fileTag($('#file2'), file, () => {
      $('#file2').innerHTML = '';
      $('#run2').disabled = true;
      $('#dl2').disabled = true;
      $('#stats2').classList.add('hidden');
      $('#stage2').innerHTML = `<div class="empty"><div>载入 SVG 后生成位图</div></div>`;
    });
  } catch (err) { alert(err.message || err); }
});

$('#outBg').addEventListener('change', e => {
  $('#bgColorRow').classList.toggle('hidden', e.target.value !== 'custom');
});
$('#outQuality').addEventListener('input', e => { $('#outQualityV').textContent = e.target.value; });
$('#run2').addEventListener('click', runRasterize);
$('#dl2').addEventListener('click', () => {
  if (S2.out) download(S2.out, stripExt(S2.file.name) + '.' + S2.ext);
});

/* ============================ Tab3 · 优化压缩 ============================ */

const S3 = { src: '', out: '', gz: null, file: null, srcSize: 0, srcUrl: '', outUrl: '' };

function optimizeSvg(src, opt) {
  let s = src;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  if (opt.meta) {
    s = s.replace(/<(metadata|title|desc)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<(metadata|title|desc)\b[^>]*\/>/gi, '');
    s = s.replace(/\s(?:xmlns:xlink|xmlns:dc|xmlns:cc|xmlns:rdf|xmlns:svg)="[^"]*"/g, '');
  }
  if (opt.comment) {
    s = s.replace(/\s(?:id|class)="[^"]*"/g, '');
    s = s.replace(/\sstyle="([^"]*)"/g, (m, v) => {
      const keep = v.split(';').filter(d => d.trim() && !/^\s*(enable-background|isolation)\s*:/.test(d)).join(';');
      return keep ? ` style="${keep}"` : '';
    });
    s = s.replace(/\s(?:data-name|data-[\w-]+)="[^"]*"/g, '');
  }
  if (opt.empty) {
    let prev;
    do {
      prev = s;
      s = s.replace(/<g\b[^>]*>\s*<\/g>/gi, '');
      s = s.replace(/<defs\b[^>]*>\s*<\/defs>/gi, '');
      s = s.replace(/<(?:clipPath|mask|pattern|symbol)\b[^>]*>\s*<\/(?:clipPath|mask|pattern|symbol)>/gi, '');
    } while (s !== prev);
  }
  if (opt.precision < 6) {
    const p = opt.precision;
    s = s.replace(/-?\d+\.\d+/g, m => {
      const fixed = parseFloat(m).toFixed(p).replace(/\.?0+$/, '');
      return fixed === '' || fixed === '-' ? '0' : fixed;
    });
  }
  s = s.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
  return s;
}

wireDrop($('#drop3'), async file => {
  try {
    const text = await readSvgFile(file);
    if (!/<svg[\s>]/i.test(text)) throw new Error('这不是一个有效的 SVG 文件');
    S3.src = text;
    S3.file = file;
    S3.srcSize = new Blob([text]).size;
    $('#run3').disabled = false;
    $('#file3').innerHTML = '';
    fileTag($('#file3'), file, () => {
      S3.src = ''; S3.out = ''; S3.gz = null;
      $('#file3').innerHTML = '';
      $('#run3').disabled = true;
      $('#dl3').disabled = true;
      $('#dl3z').disabled = true;
      $('#stats3').classList.add('hidden');
      $('#stage3').innerHTML = `<div class="empty"><div>载入 SVG 后开始优化</div></div>`;
    });
  } catch (err) { alert(err.message || err); }
});

$('#optPrec').addEventListener('input', e => { $('#optPrecV').textContent = e.target.value; });

$('#run3').addEventListener('click', async () => {
  const btn = $('#run3');
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="busy"></span>优化中…';
  await new Promise(r => setTimeout(r, 30));

  const t0 = performance.now();
  try {
    const opt = {
      meta: $('#optMeta').checked,
      comment: $('#optComment').checked,
      empty: $('#optEmpty').checked,
      precision: parseInt($('#optPrec').value, 10)
    };
    S3.out = optimizeSvg(S3.src, opt);
    const ms = performance.now() - t0;
    const outSize = new Blob([S3.out]).size;
    const saved = S3.srcSize > 0 ? (1 - outSize / S3.srcSize) * 100 : 0;

    S3.gz = $('#optGzip').checked ? await gzipBlob(S3.out) : null;

    S3.srcUrl = makeUrl(S3.srcUrl, S3.src, 'image/svg+xml');
    S3.outUrl = makeUrl(S3.outUrl, S3.out, 'image/svg+xml');

    const stage = $('#stage3');
    stage.innerHTML = `
      <div class="pane">
        <div class="pane-head"><span>原始</span><span class="hint">${fmtBytes(S3.srcSize)}</span></div>
        <div class="canvas-wrap"><img alt="原始"></div>
      </div>
      <div class="pane">
        <div class="pane-head"><span>优化后</span><span class="hint">${fmtBytes(outSize)}</span></div>
        <div class="canvas-wrap"><img alt="优化后"></div>
      </div>`;
    const imgs = $$('#stage3 img');
    imgs[0].src = S3.srcUrl;
    imgs[1].src = S3.outUrl;

    const holder = $('#stats3');
    const card = statCard([
      ['原始体积', fmtBytes(S3.srcSize)],
      ['优化后', fmtBytes(outSize)],
      ['节省', (saved >= 0 ? saved.toFixed(1) : '0') + '%'],
      [S3.gz ? 'SVGZ 体积' : '耗时', S3.gz ? fmtBytes(S3.gz.size) : ms.toFixed(1), S3.gz ? '' : 'ms']
    ]);
    holder.replaceWith(card);
    card.id = 'stats3';
    card.classList.remove('hidden');

    $('#dl3').disabled = false;
    $('#dl3z').disabled = !S3.gz;
  } catch (err) {
    console.error(err);
    alert('优化失败：' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

$('#dl3').addEventListener('click', () => {
  if (S3.out) download(new Blob([S3.out], { type: 'image/svg+xml' }), stripExt(S3.file.name) + '.min.svg');
});
$('#dl3z').addEventListener('click', () => {
  if (S3.gz) download(S3.gz, stripExt(S3.file.name) + '.min.svgz');
});

/* ============================ 启动 ============================ */

renderPresets();
renderParams();
initEngines();
