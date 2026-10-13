#!/usr/bin/env node
/* git协议被代理阻断时的 GitHub API 推送兜底（不重复提交，直接把本地 HEAD 推到远端）
 * 用法: set -a && . ./.env && set +a && node scripts/_push-api-only.cjs
 * 说明: 旧脚本用硬编码 IP 直连（20.205.243.168）→ 该 IP 证书 altnames 已不匹配，会抛
 *       "Hostname/IP does not match certificate's altnames"。本脚本改用域名（走系统代理解析）。
 * 注意: 本地与远端 commit SHA 会不同（内容树一致），这是松散同步的既有约定。
 */
const https = require('https');
const cp = require('child_process');

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) { console.error('缺少 GH_TOKEN（先 set -a && . ./.env && set +a）'); process.exit(1); }
const OWNER = 'Ri1035', REPO = 'vectorkit', BRANCH = 'main';
const HOST = process.env.GITHUB_API_HOST || 'api.github.com';

const api = (method, p, body) => new Promise((resolve, reject) => {
  const pl = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  const req = https.request({
    host: HOST, port: 443, path: p, method,
    headers: Object.assign(
      { 'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'vk-push', 'Accept': 'application/vnd.github+json' },
      pl ? { 'Content-Type': 'application/json', 'Content-Length': pl.length } : {})
  }, r => {
    let d = ''; r.setEncoding('utf8');
    r.on('data', c => d += c);
    r.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ s: r.statusCode, j, d }); });
  });
  req.on('error', reject);
  req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
  if (pl) req.write(pl);
  req.end();
});
const g = c => cp.execSync(c, { encoding: 'utf8' }).trim();
const AUTHOR = { name: 'Ri1035', email: 'koka2996978242@outlook.com' };

(async () => {
  const localSha = g('git rev-parse HEAD');
  /* 注意：不要用 git rev-parse HEAD^{tree} —— Git Bash 会先展开花括号导致参数被破坏 */
const treeSha = g("git cat-file commit HEAD | head -1 | cut -d' ' -f2");
  const msg = g('git log -1 --pretty=%B');
  const files = g('git diff-tree --no-commit-id --name-only -r HEAD').split('\n').filter(Boolean);
  console.log('本地 HEAD   ' + localSha);
  console.log('本地 tree   ' + treeSha);
  console.log('变更文件    ' + files.length + ' 个');

  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref.s !== 200) { console.error('读取远端 ref 失败', ref.s, ref.d.slice(0, 200)); process.exit(1); }
  const baseSha = ref.j.object.sha;
  console.log('远端当前    ' + baseSha);
  if (baseSha === localSha) { console.log('✓ 已一致，无需推送'); return; }

  /* 远端没有本地的 tree 对象 → 必须逐个上传 blob 再建 tree */
  const bTl = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseSha}?recursive=1`);
  const map = new Map();
  if (bTl.s === 200 && bTl.j.tree) for (const e of bTl.j.tree) if (e.type === 'blob') map.set(e.path, { sha: e.sha, mode: e.mode });

  /* 全量比对本地 HEAD 树与远端树，得出需要上传的差异 */
  const localTree = g('git ls-tree -r HEAD');
  const entries = [];
  let uploaded = 0;
  for (const line of localTree.split('\n')) {
    if (!line.trim()) continue;
    const mm = line.match(/^(\d+) blob ([0-9a-f]{40})\t(.+)$/);
    if (!mm) continue;
    const [, mode, sha, fpath] = mm;
    entries.push({ mode, sha, fpath });
    if (map.get(fpath) && map.get(fpath).sha === sha) continue; // 远端已有同内容
    const content = cp.execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 64 * 1024 * 1024 });
    const b = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`,
      { content: content.toString('base64'), encoding: 'base64' });
    if (b.s !== 201) { console.error('上传 blob 失败', fpath, b.s, b.d.slice(0, 200)); process.exit(1); }
    map.set(fpath, { sha: b.j.sha, mode });
    uploaded++;
  }
  console.log('上传 blob   ' + uploaded + ' 个（共比对 ' + entries.length + ' 个文件）');

  const t = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`,
    { base_tree: baseSha, tree: entries.map(e => ({ path: e.fpath, mode: e.mode, type: 'blob', sha: map.get(e.fpath).sha })) });
  if (t.s !== 201) { console.error('建 tree 失败', t.s, t.d.slice(0, 300)); process.exit(1); }
  const newTree = t.j.sha;
  console.log('新远端 tree ' + newTree);

  const c = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg, tree: newTree, parents: [baseSha], author: AUTHOR, committer: AUTHOR
  });
  if (c.s !== 201) { console.error('建 commit 失败', c.s, c.d.slice(0, 300)); process.exit(1); }
  const newSha = c.j.sha;
  console.log('新远端 commit ' + newSha);

  const u = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: newSha, force: false });
  if (u.s !== 200) { console.error('更新 ref 失败', u.s, u.d.slice(0, 200)); process.exit(1); }
  console.log('✓ 推送成功：' + baseSha.slice(0, 7) + ' → ' + newSha.slice(0, 7));
})().catch(e => { console.error('推送失败:', e.message); process.exit(1); });