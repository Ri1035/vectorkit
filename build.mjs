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

const files = ['index.html', 'app.js', 'svg-compat.js', 'README.md'];
for (const f of files) {
  if (fs.existsSync(path.join(root, f))) {
    fs.copyFileSync(path.join(root, f), path.join(dist, f));
  }
}
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
