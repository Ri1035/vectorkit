import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(root, 'node_modules', '@visioncortex', 'vtracer', 'pkg');
const srcPath = path.join(pkgDir, 'vtracer_wasm.js');
const wasmSrc = path.join(pkgDir, 'vtracer_wasm_bg.wasm');
const outDir = path.join(root, 'vendor');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let src = fs.readFileSync(srcPath, 'utf8');

const exported = [];
src = src.replace(/^exports\.(\w+) = (\w+);\s*$/gm, (m, name) => {
  exported.push(name);
  return '';
});

const initPattern = /const wasmPath = `\$\{__dirname\}\/vtracer_wasm_bg\.wasm`;[\s\S]*?wasm\.__wbindgen_start\(\);/;
if (!initPattern.test(src)) {
  throw new Error('未匹配到 nodejs target 的初始化代码块，包结构可能已变化');
}

src = src.replace(initPattern, `let wasm = null;
let wasmInstance = null;

export async function initVtracerWasm() {
  if (wasm) return wasm;
  if (typeof fetch !== 'function') throw new Error('当前环境不支持 fetch');
  const url = new URL('vtracer_wasm_bg.wasm', import.meta.url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('无法加载 vtracer wasm: HTTP ' + resp.status);
  const bytes = await resp.arrayBuffer();
  const mod = await WebAssembly.compile(bytes);
  wasmInstance = await WebAssembly.instantiate(mod, __wbg_get_imports());
  wasm = wasmInstance.exports;
  if (typeof wasm.__wbindgen_start === 'function') wasm.__wbindgen_start();
  return wasm;
}

/* 注意：刻意不使用顶层 await。顶层 await 会让 module worker 的模块加载永久挂起
   （实测 Chromium/Edge），因此改由调用方显式 await initVtracerWasm()。 */`);

if (!exported.length) throw new Error('未收集到任何导出符号');
src += '\nexport { ' + exported.join(', ') + ' };\n';

const header = '/* 自动生成，请勿手改。源: @visioncortex/vtracer (wasm-bindgen nodejs target) -> 浏览器 ESM 封装 */\n';

fs.writeFileSync(path.join(outDir, 'vtracer.js'), header + src, 'utf8');
fs.copyFileSync(wasmSrc, path.join(outDir, 'vtracer_wasm_bg.wasm'));

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('vtracer.js             ' + kb(fs.statSync(path.join(outDir, 'vtracer.js')).size));
console.log('vtracer_wasm_bg.wasm   ' + kb(fs.statSync(path.join(outDir, 'vtracer_wasm_bg.wasm')).size));
console.log('exports: ' + exported.join(', '));
