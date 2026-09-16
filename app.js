/* KOKA-VectorKit —— 纯前端矢量转换器
 * 引擎在主线程按需加载（见下方「引擎（懒加载）」章节） */

import { toLegacySvg } from './svg-compat.js';
import { removeSolidBackground, detectBackgroundColor, flattenOnto, opaqueRatio } from './matte.js';
import { svgToCmykEps } from './eps-export.js';
import { mergeSameColorPaths } from './merge-paths.js';
import { preprocess, countColors } from './preprocess.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* 上传时的解码上限：留出足够余量供「转换尺寸上限」做降采样 */
const MAX_SIDE = 2400;

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

/* ============================ 出图进度条 ============================
 * 引擎的 wasm 调用是同步阻塞的，拿不到真实百分比，因此采用「阶段式推进」：
 * 每个阶段映射到一个进度锚点，用定时器平滑插值靠近，不做假匀速动画。
 * 详见 docs/DESIGN.md 第八节。
 */

function createProgress(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const fill = el.querySelector('.progress-fill');
  const label = el.querySelector('.progress-label');

  let target = 0;
  let current = 0;
  let timer = null;
  let hideTimer = null;

  function paint() {
    fill.style.width = current.toFixed(2) + '%';
    el.setAttribute('aria-valuenow', String(Math.round(current)));
  }

  function step() {
    const diff = target - current;
    if (Math.abs(diff) < 0.4) {
      current = target;
      paint();
      timer = null;
      return;
    }
    current += diff * 0.2;
    paint();
    timer = setTimeout(step, 16);
  }

  function run() {
    if (timer === null) timer = setTimeout(step, 16);
  }

  function reset() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
    current = 0;
    target = 0;
    paint();
    el.classList.remove('on', 'done', 'error');
    el.setAttribute('aria-valuenow', '0');
  }

  return {
    /** 开始：显示进度条并进入「准备」阶段 */
    start(text) {
      reset();
      el.classList.add('on');
      if (label) label.textContent = text || '准备中';
      target = 6;
      run();
    },
    /** 推进到指定阶段 */
    stage(pct, text) {
      if (pct > target) target = pct;
      if (label && text) label.textContent = text + ' ' + Math.round(target) + '%';
      run();
    },
    /** 完成：填满变绿，显示耗时，1.4s 后淡出 */
    done(text) {
      target = 100;
      if (label && text) label.textContent = text;
      el.classList.add('done');
      run();
      hideTimer = setTimeout(() => {
        el.classList.remove('on');
        hideTimer = null;
      }, 1400);
    },
    /** 失败：变红并保留，直到下次操作 */
    fail(text) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
      el.classList.add('error');
      if (label) label.textContent = text || '失败';
      target = Math.max(current, 12);
      run();
    },
    reset
  };
}

const PROG = {
  1: createProgress('prog1'),
  2: createProgress('prog2'),
  3: createProgress('prog3'),
  4: createProgress('prog4')
};

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

/* ============================ 右上角开发者面板 ============================
 * 默认收起，点击按钮展开；支持点击外部关闭与 Esc 关闭。
 */

function wireDevPanel() {
  const btn = document.getElementById('devBtn');
  const panel = document.getElementById('devPanel');
  if (!btn || !panel) return;

  const setOpen = (open) => {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });

  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      btn.focus();
    }
  });

  setOpen(false);
}

/* ============================ 图像预处理设置 ============================ */

const PRE_UI = {
  size: '#preSize', denoise: '#preDenoise', smooth: '#preSmooth',
  smoothV: '#preSmoothV', colors: '#preColors', status: '#preStatus', sum: '#sumPre'
};

function collectPreOptions() {
  const size = parseInt($(PRE_UI.size).value, 10) || 0;
  const colors = parseInt($(PRE_UI.colors).value, 10) || 0;
  const denoise = $(PRE_UI.denoise).checked;
  const smooth = parseInt($(PRE_UI.smooth).value, 10) || 0;
  return {
    maxSide: size, denoise, smooth, maxColors: colors,
    active: !!size || denoise || !!smooth || colors >= 2
  };
}

/** 摘要文字：折叠状态下也能看到当前设置 */
function updatePreSummary() {
  const o = collectPreOptions();
  const parts = [o.maxSide ? o.maxSide + 'px' : '原始尺寸'];
  if (o.denoise) parts.push('去噪');
  if (o.smooth) parts.push('平滑' + o.smooth);
  parts.push(o.maxColors >= 2 ? o.maxColors + ' 色' : '不限色');
  $(PRE_UI.sum).textContent = parts.join(' · ');
}

function showPreStatus(stats) {
  const el = $(PRE_UI.status);
  if (!el || !stats) return;
  const lines = [];
  const cut = stats.colorsBefore - stats.colorsAfter;
  lines.push(`输出 ${stats.width}×${stats.height} · 颜色 <b>${stats.colorsBefore} → ${stats.colorsAfter}</b>`
    + (cut > 0 ? `（减少 ${cut}）` : '') + ` · 耗时 ${Math.round(stats.ms)}ms`);
  if (stats.steps.length) lines.push(stats.steps.map(s => escapeHtml(s)).join(' → '));
  el.innerHTML = lines.map((s, i) => `<div${i ? ' style="margin-top:3px"' : ''}>${s}</div>`).join('');
  el.classList.remove('hidden');
}

$(PRE_UI.smooth).addEventListener('input', e => {
  $(PRE_UI.smoothV).textContent = e.target.value;
  updatePreSummary();
  S1.lastKey = '';
});
[PRE_UI.size, PRE_UI.colors, PRE_UI.denoise].forEach(sel => {
  $(sel).addEventListener('change', () => {
    updatePreSummary();
    S1.lastKey = '';              // 预处理设置变化必须重新转换
  });
});
updatePreSummary();

/* ============================ 可折叠卡片 ============================
 * 用内联样式直接驱动（而非依赖 class 规则）：实测在部分环境下
 * `.collapsible.open .card-body` 虽然 matches() 为 true，但样式不会被应用，
 * 内联方式可稳定生效。
 */

function wireFold(rootId) {
  const root = document.getElementById(rootId);
  if (!root) return;
  const head = root.querySelector('.card-head');
  const body = root.querySelector('.card-body');
  if (!head || !body) return;

  const apply = (open) => {
    root.classList.toggle('open', open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      body.style.maxHeight = (body.scrollHeight + 32) + 'px';
      body.style.opacity = '1';
      body.style.marginTop = '14px';
    } else {
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      body.style.marginTop = '0px';
    }
  };

  apply(false);
  head.addEventListener('click', () => apply(!root.classList.contains('open')));

  // 内容高度变化时（如切换引擎导致预设数量变化），同步展开态高度
  root._syncHeight = () => {
    if (root.classList.contains('open')) body.style.maxHeight = (body.scrollHeight + 32) + 'px';
  };
}

/** 某个折叠面板展开时，重新计算其内容高度 */
function syncFoldHeight(rootId) {
  const root = document.getElementById(rootId);
  if (root && typeof root._syncHeight === 'function') root._syncHeight();
}

function setFoldSummary(presetText, paramsText) {
  const a = document.getElementById('sumEngine');
  const b = document.getElementById('sumParams');
  if (a && presetText) a.textContent = presetText;
  if (b && paramsText !== undefined) b.textContent = paramsText;
}

const ENGINE_LABEL = { vtracer: 'VTracer', potrace: 'Potrace' };

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
    { key: 'layerDifference', label: '层间差异阈值（越大色层越少）', min: 0, max: 64, step: 1, def: 16 },
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
  setFoldSummary(ENGINE_LABEL[S1.engine] + ' · ' + PRESETS[S1.engine][S1.preset].name);
  syncFoldHeight('foldEngine');
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
    host.appendChild(sliderRow(def, val, updateParamSummary));
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
      advHost.appendChild(sliderRow(def, val, updateParamSummary));
    }
  });

  updateParamSummary();
  syncFoldHeight('foldParams');
}

/** 折叠状态下，在「参数」标题右侧显示前两项参数值 */
function updateParamSummary() {
  const rows = $$('#params .row');
  const parts = SCHEMA[S1.engine].slice(0, 2).map((def, i) => {
    const el = rows[i] ? rows[i].querySelector('input') : null;
    const label = def.label.split(/[（(]/)[0].trim();
    return label + ' ' + (el ? el.value : '');
  });
  setFoldSummary(undefined, parts.join(' · '));
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
  $('#dlEps').disabled = false;
  $('#copy1').disabled = false;
}

async function runVectorize(force) {
  if (!S1.imageData) return;
  const btn = $('#run1');
  const prog = PROG[1];
  const restore = busy(btn, '转换中…');
  prog.start('准备中');

  try {
    const options = collectOptions();
    const wantSvgo = $('#svgoOn').checked;
    const exportMode = $('#exportMode').value;
    const preOpts = collectPreOptions();
    const key = JSON.stringify({
      e: S1.engine, o: options, s: wantSvgo, m: exportMode,
      p: preOpts, w: S1.w, h: S1.h, f: S1.file && S1.file.name
    });

    if (!force && key === S1.lastKey && S1.svg) {
      restore();
      prog.done('已复用上次结果');
      $('#hint1').textContent = '已复用上次结果';
      return;
    }

    /* 图像预处理：降采样 → 去噪 → 保边平滑 → 颜色量化，
       直接减少送入引擎的颜色种类，从源头抑制色块数量 */
    prog.stage(14, '图像预处理');
    let pw = S1.w, ph = S1.h, rgba;
    if (preOpts.active) {
      await yieldFrame();
      const pre = preprocess(S1.imageData, {
        ...preOpts,
        onProgress: (p, label) => prog.stage(10 + Math.round(p * 0.14), label)
      });
      showPreStatus(pre.stats);
      pw = pre.stats.width;
      ph = pre.stats.height;
      rgba = new Uint8Array(pre.imageData.data);
    } else {
      $(PRE_UI.status).classList.add('hidden');
      rgba = new Uint8Array(S1.imageData.data);
    }

    prog.stage(26, '加载引擎');
    const t0 = performance.now();
    prog.stage(36, '图像分析');
    let svgText = await vectorize({ engine: S1.engine, rgba, w: pw, h: ph, options });
    prog.stage(80, '矢量化');
    let svgoMs = 0;

    /* 老软件兼容模式跳过 SVGO：其紧凑输出（相对命令 / 合并路径）会加剧老解析器出错 */
    if (wantSvgo && exportMode !== 'legacy') {
      prog.stage(90, 'SVG 优化');
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

    /* 同色闭合路径合并（几何布尔并集）：放在 SVGO 之后，
       对已压缩精度的路径做几何合并，输出的对象数即最终对象数 */
    if ($('#mergeOn').checked) {
      prog.stage(92, '同色路径合并');
      try {
        const mr = await mergeSameColorPaths(svgText, {
          tolerance: +$('#mergeTol').value / 100,
          onProgress: (p, label) => prog.stage(90 + Math.round(p * 0.04), label)
        });
        svgText = mr.svg;
        showMergeStatus(1, mr.stats, mr.warnings);
      } catch (e) {
        console.warn('同色合并失败，使用原 SVG', e);
        showMergeStatus(1, null, ['同色合并失败：' + (e.message || e)]);
      }
    } else {
      hideMergeStatus(1);
    }

    prog.stage(96, '整理输出');
    svgText = ensureSvgSize(svgText, pw, ph);
    if (exportMode === 'legacy') {
      svgText = toLegacySvg(svgText);
    }
    const ms = performance.now() - t0;
    showVectorResult(svgText, ms, key);
    if (svgoMs > 0) $('#hint1').textContent = `${ms.toFixed(0)} ms · SVGO ${svgoMs.toFixed(0)} ms`;
    prog.done('完成 · ' + ms.toFixed(0) + 'ms');
  } catch (err) {
    console.error(err);
    prog.fail('转换失败');
    alert('转换失败：' + (err && err.message ? err.message : err));
  } finally {
    restore();
  }
}

function clearS1() {
  revoke(S1.srcUrl); revoke(S1.svgUrl);
  S1.imageData = null; S1.srcUrl = ''; S1.svgUrl = ''; S1.svg = ''; S1.lastKey = '';
  PROG[1].reset();
  $('#file1').innerHTML = '';
  $('#run1').disabled = true;
  $('#dl1').disabled = true;
  $('#dlEps').disabled = true;
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
    PROG[1].reset();
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

$('#exportMode').addEventListener('change', e => {
  S1.lastKey = '';
});

$('#viewToggle1').addEventListener('click', () => {
  S1.singleView = !S1.singleView;
  applySingleView();
});

$('#dl1').addEventListener('click', () => {
  if (S1.outBlob) download(S1.outBlob, S1.outName || 'vector.svg');
});

/* ---------- 同色路径合并（几何布尔并集） ---------- */

const MERGE_UI = {
  1: { on: '#mergeOn', tol: '#mergeTol', tolV: '#mergeTolV', row: '#mergeTolRow', status: '#mergeStatus' },
  3: { on: '#mergeOn3', tol: '#mergeTol3', tolV: '#mergeTolV3', row: '#mergeTolRow3', status: '#mergeStatus3' }
};

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

[1, 3].forEach(i => {
  const ui = MERGE_UI[i];
  const on = $(ui.on), tol = $(ui.tol), tolV = $(ui.tolV), row = $(ui.row);
  if (!on || !tol) return;
  const sync = () => {
    tolV.textContent = (tol.value / 100).toFixed(2);
    row.style.opacity = on.checked ? '1' : '.5';
    row.style.pointerEvents = on.checked ? '' : 'none';
  };
  tol.addEventListener('input', sync);
  on.addEventListener('change', () => {
    sync();
    if (!on.checked) hideMergeStatus(i);
  });
  sync();
});

function hideMergeStatus(i) {
  const el = $(MERGE_UI[i].status);
  if (el) { el.classList.add('hidden'); el.textContent = ''; }
}

/**
 * 展示同色合并结果与颜色检测告警
 * @param {number} i 1=位图转矢量 3=优化压缩
 */
function showMergeStatus(i, stats, warnings) {
  const el = $(MERGE_UI[i].status);
  if (!el) return;
  if (!stats && (!warnings || !warnings.length)) { hideMergeStatus(i); return; }

  const lines = [];
  if (stats) {
    const before = stats.beforeShapes;
    const after = stats.afterShapes;
    const cut = before - after;
    const pct = before ? Math.round(cut / before * 100) : 0;
    lines.push(`同色路径合并：图形 <b>${before} → ${after}</b> 个（减少 ${cut}，${pct}%）`
      + ` · 合并 ${stats.mergeGroupsDone || stats.mergeGroups} 组 · 简化锚点 ${stats.anchorsPruned || 0}`);
    const shown = stats.colors.slice(0, 8).map(escapeHtml).join(' ');
    lines.push(`检测到 <b>${stats.colorCount}</b> 种颜色：${shown}`
      + (stats.colorCount > 8 ? ` 等 ${stats.colorCount} 种` : '')
      + `　（印刷交稿建议转 CMYK，可用「下载 EPS」）`);
  }
  if (warnings && warnings.length) {
    lines.push('⚠ ' + warnings.map(escapeHtml).join('；'));
  }
  el.innerHTML = lines.map((s, idx) =>
    `<div${idx ? ' style="margin-top:3px"' : ''}>${s}</div>`).join('');
  el.classList.remove('hidden');
}

/* ---------- CMYK EPS 导出 ---------- */

function exportCmykEps(svgText, fileName, statusId, checkboxId) {
  const status = $(statusId);
  try {
    const transparent = $(checkboxId).checked;
    const { eps, warnings, shapes } = svgToCmykEps(svgText, {
      transparent,
      title: fileName
    });
    if (!status) return;
    status.classList.remove('hidden');
    if (!eps) {
      status.textContent = '⚠ ' + warnings.join('；');
      return;
    }
    download(new Blob([eps], { type: 'application/postscript' }), fileName);
    status.textContent = '已导出 ' + shapes + ' 个图形'
      + (transparent ? '（透明底）' : '（白底）')
      + (warnings.length ? ' ⚠ ' + warnings.join('；') : '');
  } catch (e) {
    console.error(e);
    if (status) {
      status.classList.remove('hidden');
      status.textContent = '⚠ EPS 导出失败：' + (e.message || e);
    }
  }
}

$('#dlEps').addEventListener('click', () => {
  if (!S1.svg) return;
  exportCmykEps(S1.svg, (S1.outName || 'vector').replace(/\.svg$/, '') + '-cmyk.eps', '#epsStatus', '#epsTransparent');
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
  PROG[1].reset();

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
  PROG[2].reset();
}

/* 用 onload + 超时替代 img.decode()：decode() 在个别环境会不 resolve，
   而 onload 是更传统、更可靠的路径。 */
function loadImage(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('图像解码超时')), timeout);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('图像解码失败')); };
    img.src = url;
  });
}

async function rasterizeViaCanvas(svgUrl, w, h, bg, format) {
  const img = await loadImage(svgUrl);
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
  const prog = PROG[2];
  prog.start('准备中');

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
      prog.stage(28, '加载引擎');
      try {
        prog.stage(58, 'resvg 渲染');
        const res = await renderWithResvg(S2.svgText, ssW, bg);
        if (format === 'image/png' && ssW === w) {
          /* 最优路径：resvg 直出 PNG 字节，不经过 canvas，保留精确抗锯齿 */
          prog.stage(90, '编码输出');
          blob = new Blob([res.png], { type: 'image/png' });
        } else {
          const pngUrl = URL.createObjectURL(new Blob([res.png], { type: 'image/png' }));
          const img = await loadImage(pngUrl);
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
          prog.stage(82, '缩放合成');
          canvas = downsample(c, w, h);
        }
      } catch (e) {
        console.warn('resvg 失败，回退 canvas', e);
      }
    }

    if (!blob && !canvas) {
      prog.stage(50, '浏览器渲染');
      canvas = await rasterizeViaCanvas(S2.svgUrl, ssW, ssH, bg, format);
      canvas = downsample(canvas, w, h);
    }
    if (!blob) {
      prog.stage(90, '编码输出');
      blob = await canvasToBlob(canvas, format, quality);
    }
    if (!blob) throw new Error('浏览器不支持该输出格式');
    prog.stage(97, '整理输出');
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
    prog.done('完成 · ' + ms.toFixed(0) + 'ms');
  } catch (err) {
    console.error(err);
    prog.fail('渲染失败');
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
      PROG[2].reset();
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
    PROG[3].reset();
    fileTag($('#file3'), file, () => {
      S3.src = ''; S3.out = ''; S3.gz = null;
      revoke(S3.srcUrl); revoke(S3.outUrl);
      S3.srcUrl = ''; S3.outUrl = '';
      PROG[3].reset();
      $('#file3').innerHTML = '';
      $('#run3').disabled = true;
      $('#dl3').disabled = true;
      $('#dl3z').disabled = true;
      $('#dlEps3').disabled = true;
      $('#stats3').classList.add('hidden');
      $('#stage3').innerHTML = emptyState(ICON_SQUEEZE, '载入 SVG 后开始优化', 'SVGO 在本地压缩，不改变矢量外观');
    });
  } catch (err) { alert(err.message || err); }
});

$('#optPrec').addEventListener('input', e => { $('#optPrecV').textContent = e.target.value; });

$('#run3').addEventListener('click', async () => {
  const btn = $('#run3');
  const restore = busy(btn, '优化中…');
  const prog = PROG[3];
  prog.start('准备中');

  const t0 = performance.now();
  try {
    const precision = parseInt($('#optPrec').value, 10);
    const useSvgo = $('#optSvgo').checked;
    const meta = $('#optMeta').checked;
    const empty = $('#optEmpty').checked;

    prog.stage(18, '解析结构');
    let out = S3.src;

    /* 同色合并作为预处理：先做几何级合并与锚点精简，再交给 SVGO 压缩 */
    if ($('#mergeOn3').checked) {
      prog.stage(30, '同色路径合并');
      try {
        const mr = await mergeSameColorPaths(out, {
          tolerance: +$('#mergeTol3').value / 100,
          onProgress: (p, label) => prog.stage(28 + Math.round(p * 0.22), label)
        });
        out = mr.svg;
        S3.mergeStats = mr.stats;
        showMergeStatus(3, mr.stats, mr.warnings);
      } catch (e) {
        console.warn('同色合并失败，使用原 SVG', e);
        S3.mergeStats = null;
        showMergeStatus(3, null, ['同色合并失败：' + (e.message || e)]);
      }
    } else {
      S3.mergeStats = null;
      hideMergeStatus(3);
    }

    if (useSvgo) {
      prog.stage(60, 'SVGO 优化');
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
      prog.stage(60, '本地优化');
      out = localOptimize(out, { meta, empty, precision });
    }

    S3.out = out;
    prog.stage(88, '统计结果');
    const ms = performance.now() - t0;
    const outSize = new Blob([out]).size;
    const saved = S3.srcSize > 0 ? (1 - outSize / S3.srcSize) * 100 : 0;

    if ($('#optGzip').checked) {
      prog.stage(93, '生成 SVGZ');
      S3.gz = await gzipBlob(out);
    } else {
      S3.gz = null;
    }

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
    $('#dlEps3').disabled = false;
    prog.done('完成 · ' + ms.toFixed(0) + 'ms');
  } catch (err) {
    console.error(err);
    prog.fail('优化失败');
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

$('#dlEps3').addEventListener('click', () => {
  if (!S3.out) return;
  exportCmykEps(S3.out, stripExt(S3.file ? S3.file.name : 'svg') + '-cmyk.eps', '#epsStatus3', '#epsTransparent3');
});

/* ============================ Tab4 · 去背景（纯色底） ============================
 * 走颜色阈值 + 软边 + 去色溢出的经典抠图算法（见 matte.js），不依赖 AI 模型：
 * 对白底商品图 / Logo / 印章这类纯色背景，速度快且边缘比 AI 更干净可控。
 */

const S4 = {
  imageData: null, w: 0, h: 0, file: null, srcUrl: '',
  outUrl: '', outBlob: null, ext: 'png', ratio: 0,
  singleView: false, keyMode: 'auto', detected: null
};

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function imageDataToCanvas(imageData) {
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c;
}

function collectMatteOpts() {
  return {
    key: S4.keyMode === 'pick' ? hexToRgb($('#matteKey').value) : null,
    tolerance: +$('#mTol').value,
    softness: +$('#mSoft').value,
    erode: +$('#mErode').value,
    feather: +$('#mFeather').value,
    despill: +$('#mDespill').value / 100,
    despeckle: +$('#mDespeckle').value
  };
}

/** 自动检测背景色并刷新色块显示 */
function detectKey() {
  if (!S4.imageData) return;
  S4.detected = detectBackgroundColor(S4.imageData);
  const hex = rgbToHex(S4.detected);
  $('#matteSwatch').style.background = hex;
  $('#matteKeyV').textContent = hex.toUpperCase();
  if (S4.keyMode === 'pick') $('#matteKey').value = hex;
}

function renderStage4() {
  const stage = $('#stage4');
  stage.innerHTML = `
    <div class="pane" data-pane="src">
      <div class="pane-head"><span>原图</span><span class="hint"></span></div>
      <div class="canvas-wrap"><img id="imgSrc4" alt="原图"></div>
    </div>
    <div class="pane" data-pane="out">
      <div class="pane-head"><span>去背景结果</span><span class="hint" id="hint4">等待处理</span></div>
      <div class="canvas-wrap" id="wrap4">
        ${emptyState('', '点击「开始去背景」', '')}
      </div>
    </div>`;
  $('#imgSrc4').src = S4.srcUrl;
  applyMatteView();
}

function applyMatteView() {
  const stage = $('#stage4');
  if (!stage.querySelector('[data-pane]')) return;
  stage.querySelector('[data-pane="src"]').style.display = S4.singleView ? 'none' : '';
  $('#viewToggle4').style.display = '';
  $('#viewToggle4').textContent = S4.singleView ? '查看原图' : '只看结果';
}

function clearMatteResult() {
  revoke(S4.outUrl);
  S4.outUrl = ''; S4.outBlob = null;
  $('#dl4').disabled = true;
  const hint = $('#hint4');
  if (hint) hint.textContent = '等待处理';
  const wrap = $('#wrap4');
  if (wrap) wrap.innerHTML = emptyState('', '点击「开始去背景」', '');
  $('#stats4').classList.add('hidden');
  PROG[4].reset();
}

/** 检测浏览器是否真的支持该格式编码（不支持时 toDataURL 会静默退回 PNG） */
const FMT_SUPPORT = {};
function supportsFormat(mime) {
  if (mime in FMT_SUPPORT) return FMT_SUPPORT[mime];
  let ok = false;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ok = c.toDataURL(mime).indexOf('data:' + mime) === 0;
  } catch { ok = false; }
  return (FMT_SUPPORT[mime] = ok);
}

/** 按输出底设置把抠出的主体合成到画布上 */
function composeMatte(imageData) {
  const w = S4.w, h = S4.h;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const bgVal = $('#mBg').value;

  if (bgVal === 'checker') {
    // 保留原图作为底，方便对照检查边缘
    ctx.drawImage(imageDataToCanvas(S4.imageData), 0, 0);
  } else if (bgVal !== 'transparent') {
    ctx.fillStyle = bgVal === 'custom' ? $('#mBgColor').value : bgVal;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(imageDataToCanvas(imageData), 0, 0);
  return out;
}

async function processMatte() {
  if (!S4.imageData) return;
  const restore = busy($('#run4'), '处理中…');
  const t0 = performance.now();
  PROG[4].start('分析背景');

  try {
    await yieldFrame();
    const opts = collectMatteOpts();

    PROG[4].stage(22, '检测背景色');
    await yieldFrame();
    if (S4.keyMode === 'auto') detectKey();

    PROG[4].stage(40, '生成蒙版');
    await yieldFrame();
    const { imageData, key } = removeSolidBackground(S4.imageData, opts);
    S4.ratio = opaqueRatio(imageData);

    PROG[4].stage(78, '合成输出');
    await yieldFrame();
    const canvas = composeMatte(imageData);

    // 浏览器不支持 WebP 编码时静默回退 PNG，避免产出「扩展名 .webp 实为 PNG」的文件
    let format = $('#mFormat').value;
    if (!supportsFormat(format)) format = 'image/png';
    S4.ext = format === 'image/webp' ? 'webp' : 'png';
    const blob = await canvasToBlob(canvas, format, 0.95) || await canvasToBlob(canvas, 'image/png');
    if (!blob) throw new Error('图片编码失败');

    revoke(S4.outUrl);
    S4.outBlob = blob;
    S4.outUrl = URL.createObjectURL(blob);

    const ms = performance.now() - t0;
    const wrap = $('#wrap4');
    wrap.innerHTML = '<img id="imgOut4" alt="去背景结果">';
    $('#imgOut4').src = S4.outUrl;
    $('#hint4').textContent = '背景 ' + rgbToHex(key).toUpperCase();
    $('#dl4').disabled = false;

    setStats('stats4', [
      ['输出体积', fmtBytes(blob.size)],
      ['尺寸', `${S4.w}×${S4.h}`],
      ['主体占比', Math.round(S4.ratio * 100) + '', '%'],
      ['耗时', Math.round(ms) + '', 'ms']
    ]).classList.remove('hidden');

    PROG[4].done('完成 · ' + Math.round(ms) + 'ms');
  } catch (e) {
    console.error(e);
    PROG[4].fail(e.message || '处理失败');
  } finally {
    restore();
  }
}

async function loadMatteFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    PROG[4].fail('请选择图片文件');
    return;
  }
  try {
    const { imageData, w, h } = await loadRaster(file);
    S4.imageData = imageData;
    S4.w = w; S4.h = h;
    S4.file = file;
    const pngBlob = await canvasToBlob(imageDataToCanvas(imageData), 'image/png');
    S4.srcUrl = makeUrl(S4.srcUrl, pngBlob || new Blob(), 'image/png');

    detectKey();
    renderStage4();
    fileTag($('#file4'), file, () => {
      S4.imageData = null; S4.file = null;
      revoke(S4.srcUrl); S4.srcUrl = '';
      $('#file4').innerHTML = '';
      $('#run4').disabled = true;
      $('#stage4').innerHTML = emptyState('', '载入一张图片后去除背景', '');
      $('#viewToggle4').style.display = 'none';
      clearMatteResult();
    });
    $('#run4').disabled = false;
    clearMatteResult();
  } catch (e) {
    console.error(e);
    PROG[4].fail('图片读取失败');
  }
}

wireDrop($('#drop4'), loadMatteFile);

$('#matteKeyMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  S4.keyMode = b.dataset.mode;
  $$('#matteKeyMode button').forEach(x => x.classList.toggle('on', x === b));
  const manual = S4.keyMode === 'pick';
  $('#matteKeyRow').style.display = manual ? '' : 'none';
  $('#matteAutoRow').style.display = manual ? 'none' : '';
  if (manual && S4.detected) $('#matteKey').value = rgbToHex(S4.detected);
});

/* 滑块数值回显 */
[['mTol', 'mTolV'], ['mSoft', 'mSoftV'], ['mErode', 'mErodeV'],
 ['mFeather', 'mFeatherV'], ['mDespill', 'mDespillV'], ['mDespeckle', 'mDespeckleV']]
  .forEach(([id, out]) => {
    const el = $('#' + id), o = $('#' + out);
    const sync = () => { o.textContent = el.value; };
    el.addEventListener('input', sync);
    sync();
  });

$('#mReset').addEventListener('click', () => {
  const defs = { mTol: 30, mSoft: 18, mErode: 1, mFeather: 1, mDespill: 60, mDespeckle: 12 };
  Object.entries(defs).forEach(([id, v]) => {
    $('#' + id).value = v;
    $('#' + id).dispatchEvent(new Event('input'));
  });
});

$('#mBg').addEventListener('change', () => {
  $('#mBgColorRow').classList.toggle('hidden', $('#mBg').value !== 'custom');
});

$('#run4').addEventListener('click', processMatte);

$('#viewToggle4').addEventListener('click', () => {
  S4.singleView = !S4.singleView;
  applyMatteView();
});

$('#dl4').addEventListener('click', () => {
  if (!S4.outBlob) return;
  const base = S4.file ? stripExt(S4.file.name) : 'image';
  download(S4.outBlob, base + '-nobg.' + S4.ext);
});

/** 去背景示例图：白底 + 彩色主体，便于直接看到效果 */
function makeMatteDemo() {
  const S = 480;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, S, S);

  // 主体：橙色圆 + 蓝色圆角方块 + 深色三角 + 绿色描边圆环
  ctx.fillStyle = '#F97316';
  ctx.beginPath(); ctx.arc(170, 175, 100, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2563EB';
  roundRect(ctx, 245, 205, 155, 150, 26); ctx.fill();
  ctx.fillStyle = '#111827';
  ctx.beginPath(); ctx.moveTo(120, 400); ctx.lineTo(205, 265); ctx.lineTo(290, 400); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#10B981';
  ctx.lineWidth = 16;
  ctx.beginPath(); ctx.arc(330, 120, 58, 0, Math.PI * 2); ctx.stroke();
  return c;
}

$('#demo4').addEventListener('click', async () => {
  const c = makeMatteDemo();
  const blob = await canvasToBlob(c, 'image/png');
  await loadMatteFile(new File([blob], 'demo-product.png', { type: 'image/png' }));
});

/* ============================ 启动 ============================ */

wireDevPanel();
wireFold('foldEngine');
wireFold('foldParams');
wireFold('foldPre');
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
