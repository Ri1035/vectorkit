import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

if (fs.existsSync(dist)) {
  for (const entry of fs.readdirSync(dist)) {
    fs.rmSync(path.join(dist, entry), { recursive: true, force: true });
  }
} else {
  fs.mkdirSync(dist, { recursive: true });
}

/* 自动收集根目录下所有前端模块（.js）——避免手动维护列表时遗漏新模块
   （曾因漏掉 dxf-export.js 导致线上 DXF 导出功能不可用） */
const files = ['index.html', 'README.md'];
for (const f of fs.readdirSync(root)) {
  if (f.endsWith('.js') && !f.startsWith('_')) files.push(f);
}
for (const f of files) {
  if (fs.existsSync(path.join(root, f))) {
    fs.copyFileSync(path.join(root, f), path.join(dist, f));
  }
}

/* 把 package.json 的版本号注入 dist 副本的 {{VERSION}} 占位符（源文件保持占位符） */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const distHtml = path.join(dist, 'index.html');
fs.writeFileSync(distHtml, fs.readFileSync(distHtml, 'utf8').replace(/\{\{VERSION\}\}/g, 'v' + pkg.version));
fs.cpSync(path.join(root, 'vendor'), path.join(dist, 'vendor'), { recursive: true });
if (fs.existsSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

let total = 0;
for (const f of walk(dist).sort()) {
  const size = fs.statSync(f).size;
  total += size;
  console.log(path.relative(dist, f).replace(/\\/g, '/').padEnd(32) + (size / 1024).toFixed(1) + ' KB');
}
console.log('-'.repeat(44));
console.log('total'.padEnd(32) + (total / 1024).toFixed(1) + ' KB');
