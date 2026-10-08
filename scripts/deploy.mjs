import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 本脚本位于 scripts/，项目根目录为其上一级 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = process.env.CF_PROJECT || 'vectorkit';
const BRANCH = process.env.CF_BRANCH || 'main';

const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('缺少环境变量: ' + missing.join(', '));
  console.error('');
  console.error('用法（bash）:');
  console.error('  export CLOUDFLARE_API_TOKEN=xxx');
  console.error('  export CLOUDFLARE_ACCOUNT_ID=xxx');
  console.error('  npm run deploy');
  process.exit(1);
}

console.log('> 构建 dist/');
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { stdio: 'inherit', cwd: root });

console.log('');
console.log('> 部署到 Cloudflare Pages（项目 ' + PROJECT + '，分支 ' + BRANCH + '）');
execFileSync(
  'npx',
  ['--yes', 'wrangler@3', 'pages', 'deploy', 'dist',
    '--project-name=' + PROJECT,
    '--branch=' + BRANCH,
    '--commit-dirty=true'],
  { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' }
);
