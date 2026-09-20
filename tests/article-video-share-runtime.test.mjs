import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadTs } from './helpers/load-typescript.mjs';

test('article video shares: admin listing, automatic exchange, scope, rotation, revoke and legacy coexistence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'article-video-share-runtime-'));
  const dbPath = path.join(directory, 'fixture.sqlite');
  const master = randomBytes(32).toString('base64');
  process.env.LOCATION_DB_PATH = dbPath;
  process.env.PRIVATE_VIDEO_MASTER_KEY = master;
  const core = loadTs('../lib/private-videos.ts', import.meta.url);
  const { getDb } = loadTs('../db/index.ts', import.meta.url);
  const db = getDb();
  const articleA = randomUUID(), articleB = randomUUID(), draft = randomUUID(), publicArticle = randomUUID();
  const videoA = randomUUID(), videoB = randomUUID(), key = randomBytes(16);
  const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
  for (const id of [videoA, videoB]) core.savePrivateVideoAsset({ id, objectPrefix: `private-videos/${id}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest, wrappedKey: core.wrapVideoKey(id, key), createdAt: Date.now() });
  for (const [id, title, status, video] of [[articleA, '分享测试文章 A', 'published', videoA], [articleB, '分享测试文章 B', 'published', videoB], [draft, '草稿视频', 'draft', videoA], [publicArticle, '旧版公开内容', 'published', null]]) {
    const content = `<p>非敏感的隔离测试内容。</p>${video ? `<video data-private-video-id="${video}" title="Synthetic video"></video>` : '<p>无私密视频。</p>'}`;
    db.prepare('INSERT INTO articles (id,title,summary,content,status,created_at,updated_at) VALUES (?,?,\'合成测试\',?,?,?,?)').run(id, title, content, status, Date.now(), Date.now());
  }
  db.close();
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, LOCATION_DB_PATH: dbPath, PRIVATE_VIDEO_MASTER_KEY: master,
      ADMIN_PASSWORD: 'article-share-fixture-password', ADMIN_SESSION_SECRET: 'article-share-fixture-session-secret',
      PRIVATE_VIDEO_UPLOAD_ENABLED: 'false', PRIVATE_VIDEO_SYNC_PRIVATE_KEY: '',
      OSS_BUCKET: 'fixture-bucket', OSS_REGION: 'oss-cn-hangzhou', OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '',
      OSS_PUBLIC_BASE_URL: 'https://fixture-media.example', OSS_ARTICLE_VIDEO_PREFIX: 'article-videos',
      WECHAT_APP_ID: '', WECHAT_APP_SECRET: '', WECHAT_APPID: '', WECHAT_APPSECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${origin}/api/private-videos/access`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error('Isolated article share fixture exited before readiness');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  const request = (url, options = {}) => fetch(origin + url, { redirect: 'manual', ...options });
  const jsonHeaders = { Origin: origin, 'Content-Type': 'application/json' };
  const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0] || '';
  const login = await request('/api/admin/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password: 'article-share-fixture-password' }) });
  assert.equal(login.status, 200);
  const adminHeaders = { ...jsonHeaders, Cookie: cookieOf(login) };
  const shareEndpoint = id => `/api/admin/articles/${id}/video-share`;
  const ensure = (id, action = 'ensure') => request(shareEndpoint(id), { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action }) });
  const exchange = (id, code, cookie = '', extra = {}) => request(`/api/articles/${id}/video-access`, { method: 'POST', headers: { ...jsonHeaders, Cookie: cookie, ...extra }, body: JSON.stringify({ code }) });
  const videoRequest = (id, cookie = '', resource = 'manifest') => request(`/api/private-videos/${id}/${resource}`, { headers: { Cookie: cookie } });
  assert.equal((await request(shareEndpoint(articleA))).status, 401);
  assert.equal((await request(shareEndpoint(articleA), { method: 'POST', headers: { ...adminHeaders, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  const untouched = await request(shareEndpoint(articleA), { headers: adminHeaders });
  assert.equal(untouched.status, 200); assert.equal((await untouched.json()).share, null);
  for (const id of [draft, publicArticle, randomUUID()]) assert.ok(!(await ensure(id)).ok, 'invalid article cannot mint a video share');
  const issuedResponse = await ensure(articleA); assert.ok(issuedResponse.ok);
  const issued = (await issuedResponse.json()).share;
  assert.match(issued.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(issued.sharePath, `/articles/${articleA}#video-access=${issued.code}`);
  assert.equal((await (await ensure(articleA)).json()).share.code, issued.code);
  const readback = await request(shareEndpoint(articleA), { headers: adminHeaders });
  assert.match(readback.headers.get('cache-control'), /no-store/);
  assert.equal((await readback.json()).share.code, issued.code, 'administrator can recover the encrypted article share code');
  const listed = await (await request('/api/admin/articles/list', { headers: adminHeaders })).json();
  assert.equal(listed.articles.find(row => row.id === articleA).hasPrivateVideos, true);
  assert.equal(listed.articles.find(row => row.id === publicArticle).hasPrivateVideos, false);
  assert.ok(listed.articles.every(row => !('content' in row)));
  assert.ok(!JSON.stringify(listed).includes(issued.code), 'bulk listing does not expose bearer codes');
  const html = await (await request(`/articles/${articleA}`)).text();
  assert.ok(!html.includes(issued.code)); assert.ok(!html.includes(master));
  assert.equal((await videoRequest(videoA)).status, 401);
  assert.equal((await exchange(articleA, issued.code, '', { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await exchange(articleB, issued.code)).status, 401, 'codes are bound to their article');
  const unlock = await exchange(articleA, issued.code); assert.equal(unlock.status, 200);
  assert.equal((await unlock.json()).authorized, true);
  assert.match(unlock.headers.get('set-cookie'), /HttpOnly/);
  assert.match(unlock.headers.get('set-cookie'), /Max-Age=2592000/);
  const cookieA = cookieOf(unlock), cookieOther = cookieOf(await exchange(articleA, issued.code));
  assert.notEqual(cookieA, cookieOther);
  for (const cookie of [cookieA, cookieOther]) {
    assert.equal((await videoRequest(videoA, cookie)).status, 200);
    const keyResponse = await videoRequest(videoA, cookie, 'key');
    assert.equal(keyResponse.status, 200); assert.deepEqual(Buffer.from(await keyResponse.arrayBuffer()), key);
    for (const resource of ['manifest', 'key', 'segments/0']) assert.equal((await videoRequest(videoB, cookie, resource)).status, 401);
  }
  assert.equal((await (await request(`/api/private-videos/access?assetId=${videoA}`, { headers: { Cookie: cookieA } })).json()).authorized, true);
  assert.equal((await (await request('/api/private-videos/access', { headers: { Cookie: cookieA } })).json()).authorized, false, 'article grant is not a site-wide code');
  const issuedB = (await (await ensure(articleB)).json()).share;
  const bothResponse = await exchange(articleB, issuedB.code, cookieA); assert.equal(bothResponse.status, 200);
  const cookieBoth = cookieOf(bothResponse) || cookieA;
  for (const id of [videoA, videoB]) assert.equal((await videoRequest(id, cookieBoth)).status, 200, 'opening another article preserves previous grants');
  const rotated = (await (await ensure(articleA, 'rotate')).json()).share;
  assert.notEqual(rotated.code, issued.code);
  for (const cookie of [cookieBoth, cookieOther]) assert.equal((await videoRequest(videoA, cookie)).status, 401);
  assert.equal((await videoRequest(videoB, cookieBoth)).status, 200);
  assert.equal((await exchange(articleA, issued.code)).status, 401);
  const currentCookie = cookieOf(await exchange(articleA, rotated.code, cookieBoth)) || cookieBoth;
  assert.equal((await videoRequest(videoA, currentCookie)).status, 200);
  const revoke = await request(shareEndpoint(articleA), { method: 'DELETE', headers: adminHeaders }); assert.equal(revoke.status, 200);
  const stopped = (await revoke.json()).share;
  assert.ok(stopped.revokedAt); assert.equal(stopped.code, null); assert.equal(stopped.sharePath, null);
  assert.equal((await (await ensure(articleA)).json()).share.code, null, 'viewing a stopped share must not silently reactivate it');
  assert.equal((await videoRequest(videoA, currentCookie)).status, 401);
  assert.equal((await exchange(articleA, rotated.code)).status, 401);
  assert.equal((await videoRequest(videoB, currentCookie)).status, 200);
  const audit = new DatabaseSync(dbPath);
  audit.prepare('UPDATE articles SET status = ? WHERE id = ?').run('draft', articleB);
  assert.equal((await videoRequest(videoB, currentCookie)).status, 401, 'unpublished article grants stop working');
  audit.prepare('UPDATE articles SET status = ? WHERE id = ?').run('published', articleB);
  assert.equal((await request('/api/private-videos/access', { method: 'DELETE', headers: { ...jsonHeaders, Cookie: currentCookie } })).status, 200);
  assert.equal((await videoRequest(videoB, currentCookie)).status, 401, 'viewer logout also drops article grants');
  audit.close();
  assert.ok(!logs.includes(master));
  for (const value of [issued.code, issuedB.code, rotated.code, cookieA.split('=')[1]]) assert.ok(!logs.includes(value), 'no credentials in fixture logs');
  if (process.env.ARTICLE_VIDEO_SHARE_UI_REVIEW === '1' && process.stdin.isTTY) {
    await ensure(articleA, 'rotate');
    console.log(`Synthetic article share UI: ${origin}/ops-7q4m/articles`);
    console.log('Fixture-only password: article-share-fixture-password. Press Enter to clean up.');
    process.stdin.resume(); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause();
  }
});
