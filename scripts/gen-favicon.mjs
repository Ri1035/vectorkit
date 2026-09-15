import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '../vendor/resvg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_W = 1283.93;
const RAW_H = 1489.51;

const rawSvg = fs.readFileSync(path.join(root, 'assets', 'logo-original.svg'), 'utf8');
const inner = rawSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

function buildSvg(size, opts) {
  const pad = size * opts.pad;
  const box = size - pad * 2;
  const scale = box / RAW_H;
  const w = RAW_W * scale;
  const x = (size - w) / 2;
  const y = pad;
  const bg = opts.bg
    ? `<rect width="${size}" height="${size}" rx="${(size * opts.radius).toFixed(2)}" fill="${opts.bg}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(6)})" fill="${opts.fg}" stroke="none">${inner}</g></svg>`;
}

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const parts = [header, dir];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
    parts.push(e.png);
  });
  return Buffer.concat(parts);
}

const VARIANTS = {
  dark:  { bg: '#18181B', fg: '#FFFFFF', pad: 0.12, radius: 0.22 },
  light: { bg: '#FFFFFF', fg: '#18181B', pad: 0.12, radius: 0.22 }
};

const manifest = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>
    .bg{fill:#18181B}
    .fg{fill:#FFFFFF}
    @media (prefers-color-scheme: dark){ .bg{fill:#FFFFFF} .fg{fill:#18181B} }
  </style>
  <rect class="bg" width="64" height="64" rx="14"/>
  <g class="fg" transform="translate(PLACEHOLDER_X PLACEHOLDER_Y) scale(PLACEHOLDER_S)">${inner}</g>
</svg>`;

function autoFaviconSvg(size) {
  const pad = size * 0.12;
  const box = size - pad * 2;
  const scale = box / RAW_H;
  const w = RAW_W * scale;
  const x = (size - w) / 2;
  const y = pad;
  return manifest
    .replace('PLACEHOLDER_X', x.toFixed(2))
    .replace('PLACEHOLDER_Y', y.toFixed(2))
    .replace('PLACEHOLDER_S', scale.toFixed(6))
    .replace('viewBox="0 0 64 64"', `viewBox="0 0 ${size} ${size}"`)
    .replace('width="64" height="64"', `width="${size}" height="${size}"`);
}

(async () => {
  const wasmBuf = fs.readFileSync(path.join(root, 'vendor', 'resvg_bg.wasm'));
  await initWasm(new Response(wasmBuf, { headers: { 'Content-Type': 'application/wasm' } }));

  const outDir = path.join(root, 'public');
  fs.mkdirSync(outDir, { recursive: true });

  const render = (svg, size) => {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    return Buffer.from(r.render().asPng());
  };

  const lines = [];

  for (const [name, opts] of Object.entries(VARIANTS)) {
    for (const size of [16, 32, 48, 64, 180, 192, 512]) {
      const png = render(buildSvg(size, opts), size);
      const file = `icon-${name}-${size}.png`;
      fs.writeFileSync(path.join(outDir, file), png);
      lines.push(file.padEnd(24) + (png.length / 1024).toFixed(1) + ' KB');
    }
  }

  const icoEntries = [16, 32, 48].map(size => ({
    size, png: render(buildSvg(size, VARIANTS.dark), size)
  }));
  const ico = buildIco(icoEntries);
  fs.writeFileSync(path.join(outDir, 'favicon.ico'), ico);
  lines.push('favicon.ico'.padEnd(24) + (ico.length / 1024).toFixed(1) + ' KB');

  const svgFav = autoFaviconSvg(64);
  fs.writeFileSync(path.join(outDir, 'favicon.svg'), svgFav);
  lines.push('favicon.svg'.padEnd(24) + (Buffer.byteLength(svgFav) / 1024).toFixed(1) + ' KB');

  fs.copyFileSync(path.join(outDir, 'icon-dark-180.png'), path.join(outDir, 'apple-touch-icon.png'));
  lines.push('apple-touch-icon.png'.padEnd(24) + ' (copy of icon-dark-180)');

  fs.writeFileSync(path.join(outDir, 'icon.svg'), buildSvg(64, VARIANTS.dark));
  lines.push('icon.svg'.padEnd(24) + ' (RSS / generic)');

  console.log(lines.join('\n'));
})();
