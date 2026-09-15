/* VectorKit —— 纯前端矢量转换器
 * 引擎全部跑在 worker.js 里，主线程只负责 UI 与轻量合成 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const MAX_SIDE = 1600;

/* ============================ 引擎（懒加载） ============================
 * 说明：曾尝试把引擎放进 Web Worker，但实测 module worker 内的模块加载
 * 会永久挂起（静态与动态 import 均如此，Chromium/Edge 复现），
 * 因此改为主线程懒加载 + 结果缓存 + 让出帧的方式保证流畅度。
 * 引擎只在首次真正用到时才下载，首屏不加载任何 wasm。
 */

const ENGINES = {
  vtracer: { mod: null, loading: null },
  potrace: { mod: null, loading: null },
  resvg: { mod: null, loading: null },
  svgo: { mod: null, loading: null }
};

function loadEngine(name) {
  const slot = ENGINES[name];
  if (slot.mod) return Promise.resolve(slot.mod);
  if (slot.loading) return slot.loading;

  slot.loading = (async () => {
    try {
      if (name === 'vtracer') {
        const m = await import('./vendor/vtracer.js');
        if (typeof m.initVtracerWasm === 'function') await m.initVtracerWasm();
        slot.mod = m;
      } else if (name === 'potrace') {
        const m = await import('./vendor/potrace.js');
        if (typeof m.init === 'function') await m.init();
        slot.mod = m;
      } else if (name === 'resvg') {
        const m = await import('./vendor/resvg.mjs');
        const resp = await fetch('./vendor/resvg_bg.wasm');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        await m.initWasm(new Response(buf, { headers: { 'Content-Type': 'application/wasm' } }));
        slot.mod = m;
      } else if (name === 'svgo') {
        slot.mod = await import('./vendor/svgo.js');
      }
      return slot.mod;
    } catch (e) {
      slot.loading = null;
      throw e;
    }
  })();

  return slot.loading;
}

async function warmup() {
  const names = [];
  const results = await Promise.allSettled([
    loadEngine('vtracer').then(() => names.push('VTracer')),
    loadEngine('potrace').then(() => names.push('Potrace')),
    loadEngine('resvg').then(() => names.push('resvg')),
    loadEngine('svgo').then(() => names.push('SVGO'))
  ]);
  const okCount = results.filter(r => r.status === 'fulfilled').length;
  const narrow = window.matchMedia('(max-width: 520px)').matches;
  if (okCount === 0) {
    setChip('err', '引擎加载失败');
  } else if (narrow) {
    setChip('ready', '引擎就绪');
  } else {
    setChip('ready', '引擎就绪 · ' + names.join(' + '));
  }
}

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

function dataUrlToBlob(dataUrl) {
  const head = dataUrl.slice(0, dataUrl.indexOf(','));
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

/* canvas.toBlob 在部分环境（无头/虚拟时间）不会回调，这里做同步回退：
   1.5s 内 toBlob 没结果就改走同步的 toDataURL，保证一定能出图。 */
function canvasToBlob(canvas, format, quality) {
  return new Promise(resolve => {
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      try { resolve(dataUrlToBlob(canvas.toDataURL(format, quality))); }
      catch (e) { resolve(null); }
    };
    const timer = setTimeout(fallback, 1500);
    try {
      canvas.toBlob(b => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(b || fallback());
      }, format, quality);
    } catch (e) {
      clearTimeout(timer);
      fallback();
    }
  });
}

async function vectorize(opts) {
  if (opts.engine === 'potrace') {
    const m = await loadEngine('potrace');
    const imgData = new ImageData(new Uint8ClampedArray(opts.rgba), opts.w, opts.h);
    return await m.potrace(imgData, opts.options);
  }
  const m = await loadEngine('vtracer');
  return m.vectorize_rgba(opts.rgba, opts.w, opts.h, opts.options);
}

async function svgoOptimize(svg, config) {
  const m = await loadEngine('svgo');
  const res = m.optimize(svg, config);
  return res && res.data ? res.data : svg;
}

async function renderWithResvg(svg, width, background) {
  const m = await loadEngine('resvg');
  const o = { fitTo: { mode: 'width', value: width } };
  if (background && background !== 'transparent') o.background = background;
  const inst = new m.Resvg(svg, o);
  const rendered = inst.render();
  return { png: new Uint8Array(rendered.asPng()), width: rendered.width, height: rendered.height };
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
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function makeUrl(prev, payload, mime) {
  if (prev && typeof prev === 'string' && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
  const blob = mime ? new Blob([payload], { type: mime }) : payload;
  return URL.createObjectURL(blob);
}

function revoke(u) {
  if (u && typeof u === 'string' && u.startsWith('blob:')) URL.revokeObjectURL(u);
}

const stripExt = n => n.replace(/\.[^.]+$/, '');

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
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
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
  row.innerHTML = `<span class="nm"></span><span class="sz"></span><button class="rm" type="button" title="移除" aria-label="移除文件">×</button>`;
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
  pick.addEventListener('change', () => {
    if (pick.files[0]) inputHandler(pick.files[0]);
    pick.value = '';
  });

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

function setStats(oldId, items) {
  const card = statCard(items);
  card.id = oldId;
  const prev = $('#' + oldId);
  if (prev && prev.parentNode) prev.replaceWith(card);
  else $('#stage' + oldId.slice(-1)).parentNode.appendChild(card);
  return card;
}

function busy(btn, label) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  return () => { btn.disabled = false; btn.innerHTML = old; };
}

function emptyState(icon, title, sub) {
  return `<div class="empty">
    <div class="big">${icon}</div>
    <div>${title}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

const ICON_IMAGE = `<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>`;
const ICON_SQUEEZE = `<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 8l7-5 7 5v8l-7 5-7-5z"/></svg>`;

/* ============================ Tab 切换 ============================ */

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab.dataset.tab));
  });
});

/* ============================ 引擎初始化 ============================ */

function setChip(state, text) {
  const chip = $('#engineChip');
  chip.classList.remove('busy', 'ready', 'err');
  if (state) chip.classList.add(state);
  $('#engineText').textContent = text;
}

/* ============================ 预设与参数 ============================ */

const PRESETS = {
  vtracer: {
    logo:   { name: 'Logo 图标', desc: '扁平色块，边界锐利', opts: { clustering: 'color-cluster', hierarchical: 'cutout', filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    photo:  { name: '照片', desc: '连续色调，保留细节', opts: { preset: 'photo', filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 1, hierarchical: 'stacked' } },
    line:   { name: '线稿 / 签名', desc: '黑白线条与轮廓', opts: { clustering: 'bw', adaptive: true, filterSpeckle: 2, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    poster: { name: '海报扁平', desc: '自动减色，体积更小', opts: { preset: 'poster', maxColors: 12, hierarchical: 'cutout', simplify: 1.5, optimize: 2, filterSpeckle: 4, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, mode: 'spline', pathPrecision: 2 } },
    pixel:  { name: '像素画', desc: '保留硬边方格', opts: { clustering: 'color-cluster', mode: 'pixel', filterSpeckle: 0, colorPrecision: 8, maxIterations: 0, pathPrecision: 0 } }
  },
  potrace: {
    sharp:  { name: '锐利线条', desc: '拐角保留，几何图形', opts: { turdsize: 2, alphamax: 0, opticurve: 1, opttolerance: 0.2, extractcolors: 0, turnpolicy: 4 } },
    smooth: { name: '圆润曲线', desc: '平滑，适合手绘', opts: { turdsize: 4, alphamax: 1.334, opticurve: 1, opttolerance: 0.4, extractcolors: 0, turnpolicy: 4 } },
    clean:  { name: '强去噪', desc: '忽略零碎斑点', opts: { turdsize: 16, alphamax: 1, opticurve: 1, opttolerance: 0.3, extractcolors: 0, turnpolicy: 4 } },
    poster: { name: '海报分层', desc: '多色调分色输出', opts: { turdsize: 2, alphamax: 1, opticurve: 1, opttolerance: 0.2, extractcolors: 1, posterizelevel: 8, posterizationalgorithm: 1, turnpolicy: 4 } }
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
    { key: 'colorPrecision', label: '颜色精度', type: 'range', min: 1, max: 8, step: 1, def: 6 },
    { key: 'pathPrecision', label: '路径精度', type: 'range', min: 0, max: 8, step: 1, def: 2 },
    { key: 'simplify', label: '曲线简化容差（0 关闭）', type: 'range', min: 0, max: 5, step: 0.5, def: 0 }
  ],
  potrace: [
    { key: 'turnpolicy', label: '拐角策略', type: 'select', options: [['4', '少数派（推荐）'], ['0', '黑色优先'], ['1', '白色优先'], ['5', '多数派']] },
    { key: 'opticurve', label: '曲线优化', type: 'select', options: [['1', '开启'], ['0', '关闭']] },
    { key: 'extractcolors', label: '彩色分层', type: 'select', options: [['0', '关闭（纯黑白）'], ['1', '开启（海报化）']] }
  ]
};

const S1 = {
  imageData: null, file: null, srcUrl: '', outUrl: '',
  engine: 'vtracer', preset: 'logo',
  svg: '', outBlob: null, outName: '', w: 0, h: 0,
  lastKey: '', lastResult: null, singleView: false
};

function renderPresets() {
  const host = $('#presets');
  host.innerHTML = '';
  Object.entries(PRESETS[S1.engine]).forEach(([id, p]) => {
    const b = document.createElement('button');
    b.type = 'button';
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

function sliderRow(def, val, onChange) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label></label><input type="range" min="${def.min}" max="${def.max}" step="${def.step}"><output></output>`;
  $('label', row).textContent = def.label;
  const input = $('input', row);
  const out = $('output', row);
  input.value = val;
  out.textContent = val;
  input.addEventListener('input', () => { out.textContent = input.value; if (onChange) onChange(); });
  return row;
}

function renderParams() {
  const opts = PRESETS[S1.engine][S1.preset].opts;
  const host = $('#params');
  host.innerHTML = '';

  SCHEMA[S1.engine].forEach(def => {
    const val = opts[def.key] !== undefined ? opts[def.key] : (def.def !== undefined ? def.def : def.min);
    host.appendChild(sliderRow(def, val));
  });

  const advHost = $('#advBox');
  advHost.innerHTML = '';
  ADV[S1.engine].forEach(def => {
    if (def.type === 'select') {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label></label><select>${def.options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
      $('label', row).textContent = def.label;
      const val = opts[def.key] !== undefined ? opts[def.key] : def.options[0][0];
      $('select', row).value = String(val);
      advHost.appendChild(row);
    } else {
      const val = opts[def.key] !== undefined ? opts[def.key] : (def.def !== undefined ? def.def : def.min);
      advHost.appendChild(sliderRow(def, val));
    }
  });
}

function collectOptions() {
  const base = Object.assign({}, PRESETS[S1.engine][S1.preset].opts);
  const rows = $$('#params .row');
  SCHEMA[S1.engine].forEach((def, i) => {
    base[def.key] = parseFloat($('input', rows[i]).value);
  });
  const advRows = $$('#advBox .row');
  ADV[S1.engine].forEach((def, i) => {
    const el = $('select', advRows[i]) || $('input', advRows[i]);
    if (def.type === 'select') {
      const raw = el.value;
      base[def.key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else {
      base[def.key] = parseFloat(el.value);
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

/* ============================ Tab1 · 位图转矢量 ============================ */

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
  bmp.close && bmp.close();
  return { imageData: ctx.getImageData(0, 0, w, h), w, h };
}

function renderStage1() {
  const stage = $('#stage1');
  stage.innerHTML = `
    <div class="pane" data-pane="src">
      <div class="pane-head"><span>原图</span><span class="hint"></span></div>
      <div class="canvas-wrap"><img id="imgSrc" alt="原图"></div>
    </div>
    <div class="pane" data-pane="out">
      <div class="pane-head"><span>矢量化结果</span><span class="hint" id="hint1">等待转换</span></div>
      <div class="canvas-wrap" id="wrap1">
        ${emptyState('', '点击「开始转换」', '')}
      </div>
    </div>`;
  $('#imgSrc').src = S1.srcUrl;
  applySingleView();
}

function applySingleView() {
  const stage = $('#stage1');
  if (!stage.querySelector('[data-pane]')) return;
  stage.querySelector('[data-pane="src"]').style.display = S1.singleView ? 'none' : '';
  $('#viewToggle1').style.display = '';
  $('#viewToggle1').textContent = S1.singleView ? '查看原图' : '只看结果';
}

function showVectorResult(svgText, ms, key) {
  const bytes = new Blob([svgText]).size;
  const paths = (svgText.match(/<path/gi) || []).length;
  const nodes = (svgText.match(/[MmLlCcSsQqTtAaZz]/g) || []).length;

  S1.svgUrl = makeUrl(S1.svgUrl, svgText, 'image/svg+xml');
  S1.svg = svgText;
  S1.outBlob = new Blob([svgText], { type: 'image/svg+xml' });
  S1.lastKey = key;

  const wrap = $('#wrap1');
  wrap.innerHTML = `<img alt="矢量化结果">`;
  $('img', wrap).src = S1.svgUrl;
  $('#hint1').textContent = ms.toFixed(0) + ' ms';

  setStats('stats1', [
    ['输出体积', fmtBytes(bytes)],
    ['路径数', paths],
    ['路径节点', nodes],
    ['耗时', ms.toFixed(0), 'ms']
  ]);

  $('#dl1').disabled = false;
  $('#copy1').disabled = false;
}

async function runVectorize(force) {
  if (!S1.imageData) return;
  const btn = $('#run1');
  const restore = busy(btn, '转换中…');

  try {
    const options = collectOptions();
    const wantSvgo = $('#svgoOn').checked;
    const key = JSON.stringify({ e: S1.engine, o: options, s: wantSvgo, w: S1.w, h: S1.h, f: S1.file && S1.file.name });

    if (!force && key === S1.lastKey && S1.svg) {
      restore();
      $('#hint1').textContent = '已复用上次结果';
      return;
    }

    const t0 = performance.now();
    const rgba = new Uint8Array(S1.imageData.data);
    let svgText = await vectorize({ engine: S1.engine, rgba, w: S1.w, h: S1.h, options });
    let svgoMs = 0;

    if (wantSvgo) {
      try {
        const t1 = performance.now();
        svgText = await svgoOptimize(svgText, {
          multipass: true,
          floatPrecision: 3,
          plugins: [{ name: 'preset-default', params: { overrides: { removeViewBox: false } } }]
        });
        svgoMs = performance.now() - t1;
      } catch (e) {
        console.warn('SVGO 优化跳过', e);
      }
    }

    const ms = performance.now() - t0;
    svgText = ensureSvgSize(svgText, S1.w, S1.h);
    showVectorResult(svgText, ms, key);
    if (svgoMs > 0) $('#hint1').textContent = `${ms.toFixed(0)} ms · SVGO ${svgoMs.toFixed(0)} ms`;
  } catch (err) {
    console.error(err);
    alert('转换失败：' + (err && err.message ? err.message : err));
  } finally {
    restore();
  }
}

function clearS1() {
  revoke(S1.srcUrl); revoke(S1.svgUrl);
  S1.imageData = null; S1.srcUrl = ''; S1.svgUrl = ''; S1.svg = ''; S1.lastKey = '';
  $('#file1').innerHTML = '';
  $('#run1').disabled = true;
  $('#dl1').disabled = true;
  $('#copy1').disabled = true;
  $('#viewToggle1').style.display = 'none';
  $('#stats1').classList.add('hidden');
  $('#stage1').innerHTML = emptyState(ICON_IMAGE, '载入一张图片后开始转换', '转换全程在本地完成，不产生任何网络请求');
}

wireDrop($('#drop1'), async file => {
  try {
    const res = await loadRaster(file);
    S1.imageData = res.imageData;
    S1.w = res.w; S1.h = res.h;
    S1.file = file;
    S1.outName = stripExt(file.name) + '.svg';
    S1.lastKey = '';
    revoke(S1.srcUrl);
    S1.srcUrl = URL.createObjectURL(file);
    renderStage1();
    fileTag($('#file1'), file, clearS1);
    $('#run1').disabled = false;
    $('#rerun1').classList.remove('hidden');
  } catch (err) {
    alert('无法读取该图片：' + (err.message || err));
  }
});

$('#engineSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  S1.engine = b.dataset.engine;
  S1.preset = Object.keys(PRESETS[S1.engine])[0];
  S1.lastKey = '';
  $$('#engineSeg button').forEach(x => {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderPresets();
  renderParams();
});

$('#advToggle').addEventListener('click', () => {
  const t = $('#advToggle');
  t.classList.toggle('open');
  $('#advBox').classList.toggle('open');
});

$('#run1').addEventListener('click', () => runVectorize(false));
$('#rerun1').addEventListener('click', () => runVectorize(true));
$('#svgoOn').addEventListener('change', () => { S1.lastKey = ''; });

$('#viewToggle1').addEventListener('click', () => {
  S1.singleView = !S1.singleView;
  applySingleView();
});

$('#dl1').addEventListener('click', () => {
  if (S1.outBlob) download(S1.outBlob, S1.outName || 'vector.svg');
});

$('#copy1').addEventListener('click', async () => {
  const b = $('#copy1');
  try {
    await navigator.clipboard.writeText(S1.svg);
    b.textContent = '已复制';
    b.classList.add('done');
    setTimeout(() => { b.textContent = '复制源码'; b.classList.remove('done'); }, 1400);
  } catch {
    alert('浏览器拒绝了剪贴板访问');
  }
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
  S1.lastKey = '';

  revoke(S1.srcUrl);
  S1.srcUrl = c.toDataURL('image/png');
  renderStage1();

  const name = useColor ? 'demo-logo.png' : 'demo-sketch.png';
  S1.file = { name, size: Math.round(S1.srcUrl.length * 0.72) };
  fileTag($('#file1'), S1.file, clearS1);
  $('#run1').disabled = false;
});

/* ============================ Tab2 · 矢量转位图 ============================ */

const S2 = { svgText: '', svgUrl: '', outUrl: '', file: null, w: 0, h: 0, out: null, ext: 'png' };

async function loadSvgForRaster(file) {
  const text = await readSvgFile(file);
  if (!/<svg[\s>]/i.test(text)) throw new Error('这不是一个有效的 SVG 文件');
  const meta = parseSvgMeta(text);
  S2.svgText = text;
  S2.file = file;
  S2.w = meta.w; S2.h = meta.h;
  S2.svgUrl = makeUrl(S2.svgUrl, text, 'image/svg+xml');

  $('#stage2').innerHTML = emptyState(
    ICON_IMAGE,
    `已载入 ${meta.w} × ${meta.h}`,
    '设置好右侧参数后点击「生成位图」'
  ) + `<div class="pane" style="border-top:1px solid var(--border)"><div class="canvas-wrap plain"><img src="${S2.svgUrl}" alt="SVG 预览" style="max-height:320px"></div></div>`;
  $('#run2').disabled = false;
  $('#dl2').disabled = true;
  $('#stats2').classList.add('hidden');
}

async function rasterizeViaCanvas(svgUrl, w, h, bg, format) {
  const img = new Image();
  img.decoding = 'sync';
  img.src = svgUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg && bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  } else if (format === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function downsample(srcCanvas, w, h) {
  if (srcCanvas.width === w && srcCanvas.height === h) return srcCanvas;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return c;
}

async function runRasterize() {
  const btn = $('#run2');
  const restore = busy(btn, '渲染中…');

  const t0 = performance.now();
  try {
    const scale = parseFloat($('#outScale').value);
    const format = $('#outFormat').value;
    const quality = parseFloat($('#outQuality').value) / 100;
    const engine = $('#outEngine').value;
    const ss = parseInt($('#outSS').value, 10) || 0;
    let bg = $('#outBg').value;
    if (bg === 'custom') bg = $('#outBgColor').value;

    const w = Math.max(1, Math.round(S2.w * scale));
    const h = Math.max(1, Math.round(S2.h * scale));

    /* 超采样有像素上限：防止大图 × 大倍率 × 超采样叠加后渲染过慢或内存溢出。
       上限约 1600 万像素（≈4000×4000），超过则自动放弃超采样。 */
    const MAX_RENDER_PX = 16 * 1024 * 1024;
    let ssW = w, ssH = h;
    if (ss > 1 && w * h * ss * ss <= MAX_RENDER_PX) {
      ssW = w * ss;
      ssH = h * ss;
    }

    let blob = null;
    let canvas = null;

    if (engine === 'resvg') {
      try {
        const res = await renderWithResvg(S2.svgText, ssW, bg);
        if (format === 'image/png' && ssW === w) {
          /* 最优路径：resvg 直出 PNG 字节，不经过 canvas，保留精确抗锯齿 */
          blob = new Blob([res.png], { type: 'image/png' });
        } else {
          const pngUrl = URL.createObjectURL(new Blob([res.png], { type: 'image/png' }));
          const img = new Image();
          img.src = pngUrl;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = ssW; c.height = ssH;
          const ctx = c.getContext('2d');
          if (bg && bg !== 'transparent') {
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, ssW, ssH);
          } else if (format === 'image/jpeg') {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, ssW, ssH);
          }
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, ssW, ssH);
          URL.revokeObjectURL(pngUrl);
          canvas = downsample(c, w, h);
        }
      } catch (e) {
        console.warn('resvg 失败，回退 canvas', e);
      }
    }

    if (!blob && !canvas) {
      canvas = await rasterizeViaCanvas(S2.svgUrl, ssW, ssH, bg, format);
      canvas = downsample(canvas, w, h);
    }
    if (!blob) {
      blob = await canvasToBlob(canvas, format, quality);
    }
    if (!blob) throw new Error('浏览器不支持该输出格式');
    const ms = performance.now() - t0;

    S2.out = blob;
    S2.ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';

    $('#stage2').innerHTML = `
      <div class="pane">
        <div class="pane-head"><span>SVG 源</span><span class="hint">${S2.w} × ${S2.h}</span></div>
        <div class="canvas-wrap plain"><img alt="源 SVG"></div>
      </div>
      <div class="pane">
        <div class="pane-head"><span>渲染输出</span><span class="hint">${ms.toFixed(0)} ms</span></div>
        <div class="canvas-wrap"><img alt="输出位图"></div>
      </div>`;
    const imgs = $$('#stage2 img');
    imgs[0].src = S2.svgUrl;
    S2.outUrl = makeUrl(S2.outUrl, blob);
    imgs[1].src = S2.outUrl;

    setStats('stats2', [
      ['输出尺寸', `${w} × ${h}`],
      ['输出体积', fmtBytes(blob.size)],
      ['引擎', engine === 'resvg' ? 'resvg' : 'canvas'],
      ['耗时', ms.toFixed(0), 'ms']
    ]);

    $('#dl2').disabled = false;
  } catch (err) {
    console.error(err);
    alert('渲染失败：' + (err.message || err));
  } finally {
    restore();
  }
}

wireDrop($('#drop2'), async file => {
  try {
    await loadSvgForRaster(file);
    fileTag($('#file2'), file, () => {
      revoke(S2.svgUrl);
      S2.svgText = ''; S2.svgUrl = '';
      $('#file2').innerHTML = '';
      $('#run2').disabled = true;
      $('#dl2').disabled = true;
      $('#stats2').classList.add('hidden');
      $('#stage2').innerHTML = emptyState(ICON_IMAGE, '载入 SVG 后生成位图', 'resvg 引擎提供跨设备一致的抗锯齿质量');
    });
  } catch (err) { alert(err.message || err); }
});

$('#outBg').addEventListener('change', e => {
  $('#bgColorRow').classList.toggle('hidden', e.target.value !== 'custom');
});
$('#outQuality').addEventListener('input', e => { $('#outQualityV').textContent = e.target.value; });
$('#outFormat').addEventListener('change', e => {
  $('#qualityRow').style.opacity = e.target.value === 'image/png' ? '.45' : '1';
});
$('#run2').addEventListener('click', runRasterize);
$('#dl2').addEventListener('click', () => {
  if (S2.out && S2.file) download(S2.out, stripExt(S2.file.name) + '.' + S2.ext);
});

/* ============================ Tab3 · 优化压缩 ============================ */

const S3 = { src: '', out: '', gz: null, file: null, srcSize: 0, srcUrl: '', outUrl: '' };

function localOptimize(src, opt) {
  let s = src;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  if (opt.meta) {
    s = s.replace(/<(metadata|title|desc)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<(metadata|title|desc)\b[^>]*\/>/gi, '');
    s = s.replace(/\s(?:xmlns:xlink|xmlns:dc|xmlns:cc|xmlns:rdf)="[^"]*"/g, '');
  }
  if (opt.empty) {
    let prev;
    do {
      prev = s;
      s = s.replace(/<g\b[^>]*>\s*<\/g>/gi, '');
      s = s.replace(/<defs\b[^>]*>\s*<\/defs>/gi, '');
    } while (s !== prev);
  }
  if (opt.precision < 6) {
    const p = opt.precision;
    s = s.replace(/-?\d+\.\d+/g, m => {
      const fixed = parseFloat(m).toFixed(p).replace(/\.?0+$/, '');
      return fixed === '' || fixed === '-' ? '0' : fixed;
    });
  }
  return s.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
}

wireDrop($('#drop3'), async file => {
  try {
    const text = await readSvgFile(file);
    if (!/<svg[\s>]/i.test(text)) throw new Error('这不是一个有效的 SVG 文件');
    S3.src = text;
    S3.file = file;
    S3.srcSize = new Blob([text]).size;
    $('#run3').disabled = false;
    fileTag($('#file3'), file, () => {
      S3.src = ''; S3.out = ''; S3.gz = null;
      revoke(S3.srcUrl); revoke(S3.outUrl);
      S3.srcUrl = ''; S3.outUrl = '';
      $('#file3').innerHTML = '';
      $('#run3').disabled = true;
      $('#dl3').disabled = true;
      $('#dl3z').disabled = true;
      $('#stats3').classList.add('hidden');
      $('#stage3').innerHTML = emptyState(ICON_SQUEEZE, '载入 SVG 后开始优化', 'SVGO 在本地压缩，不改变矢量外观');
    });
  } catch (err) { alert(err.message || err); }
});

$('#optPrec').addEventListener('input', e => { $('#optPrecV').textContent = e.target.value; });

$('#run3').addEventListener('click', async () => {
  const btn = $('#run3');
  const restore = busy(btn, '优化中…');

  const t0 = performance.now();
  try {
    const precision = parseInt($('#optPrec').value, 10);
    const useSvgo = $('#optSvgo').checked;
    const meta = $('#optMeta').checked;
    const empty = $('#optEmpty').checked;

    let out = S3.src;

    if (useSvgo) {
      try {
        out = await svgoOptimize(out, {
          multipass: true,
          floatPrecision: precision,
          plugins: [{
            name: 'preset-default',
            params: { overrides: { removeViewBox: false, removeTitle: !meta, removeDesc: !meta } }
          }]
        });
      } catch (e) {
        console.warn('SVGO 失败，回退本地优化', e);
        out = localOptimize(out, { meta, empty, precision });
      }
    } else {
      out = localOptimize(out, { meta, empty, precision });
    }

    S3.out = out;
    const ms = performance.now() - t0;
    const outSize = new Blob([out]).size;
    const saved = S3.srcSize > 0 ? (1 - outSize / S3.srcSize) * 100 : 0;

    S3.gz = $('#optGzip').checked ? await gzipBlob(out) : null;

    S3.srcUrl = makeUrl(S3.srcUrl, S3.src, 'image/svg+xml');
    S3.outUrl = makeUrl(S3.outUrl, out, 'image/svg+xml');

    $('#stage3').innerHTML = `
      <div class="pane">
        <div class="pane-head"><span>原始</span><span class="hint">${fmtBytes(S3.srcSize)}</span></div>
        <div class="canvas-wrap plain"><img alt="原始"></div>
      </div>
      <div class="pane">
        <div class="pane-head"><span>优化后</span><span class="hint">${fmtBytes(outSize)}</span></div>
        <div class="canvas-wrap plain"><img alt="优化后"></div>
      </div>`;
    const imgs = $$('#stage3 img');
    imgs[0].src = S3.srcUrl;
    imgs[1].src = S3.outUrl;

    setStats('stats3', [
      ['原始体积', fmtBytes(S3.srcSize)],
      ['优化后', fmtBytes(outSize)],
      ['节省', (saved > 0 ? saved.toFixed(1) : '0') + '%'],
      [S3.gz ? 'SVGZ' : '耗时', S3.gz ? fmtBytes(S3.gz.size) : ms.toFixed(1), S3.gz ? '' : 'ms']
    ]);

    $('#dl3').disabled = false;
    $('#dl3z').disabled = !S3.gz;
  } catch (err) {
    console.error(err);
    alert('优化失败：' + (err.message || err));
  } finally {
    restore();
  }
});

$('#dl3').addEventListener('click', () => {
  if (S3.out && S3.file) download(new Blob([S3.out], { type: 'image/svg+xml' }), stripExt(S3.file.name) + '.min.svg');
});
$('#dl3z').addEventListener('click', () => {
  if (S3.gz && S3.file) download(S3.gz, stripExt(S3.file.name) + '.min.svgz');
});

/* ============================ 启动 ============================ */

renderPresets();
renderParams();

function scheduleWarmup() {
  setTimeout(() => { warmup(); }, 180);
}
if (document.readyState === 'complete') {
  scheduleWarmup();
} else {
  window.addEventListener('load', scheduleWarmup, { once: true });
}
