import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadTs } from './helpers/load-typescript.mjs';

test('Next private-video endpoints: code login, separate viewer/admin auth, revoke, editor publish and legacy compatibility', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-video-runtime-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const master = randomBytes(32).toString('base64');
  const key = randomBytes(16), id = randomUUID(), secondId = randomUUID();
  process.env.PRIVATE_VIDEO_MASTER_KEY = master;
  const core = loadTs('../lib/private-videos.ts', import.meta.url);
  const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE private_video_assets (id TEXT PRIMARY KEY, object_prefix TEXT, bucket TEXT, region TEXT, manifest TEXT, wrapped_key TEXT, created_at INTEGER)');
  for (const videoId of [id, secondId]) db.prepare('INSERT INTO private_video_assets VALUES (?, ?, ?, ?, ?, ?, ?)').run(videoId, `private-videos/${videoId}`, 'fixture-bucket', 'oss-cn-hangzhou', manifest, core.wrapVideoKey(videoId, key), Date.now());
  db.close();
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const syncSecret = 'synthetic-private-video-sync-secret-at-least32';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, LOCATION_DB_PATH: dbPath, VIDEO_IMPORT_DIR: path.join(directory, 'video-imports'),
      ADMIN_PASSWORD: 'private-video-fixture-password', ADMIN_SESSION_SECRET: 'private-video-fixture-session-secret',
      ARTICLE_SYNC_SECRET: syncSecret, ARTICLE_SYNC_ALLOW_PRIVATE: 'true',
      PRIVATE_VIDEO_MASTER_KEY: master, PRIVATE_VIDEO_SYNC_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
      PRIVATE_VIDEO_UPLOAD_ENABLED: 'false', PRIVATE_VIDEO_OSS_PREFIX: 'private-videos',
      OSS_BUCKET: 'fixture-bucket', OSS_REGION: 'oss-cn-hangzhou', OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '',
      OSS_PUBLIC_BASE_URL: 'https://fixture-media.example', OSS_ARTICLE_VIDEO_PREFIX: 'article-videos',
      VIDEO_FFMPEG_PATH: '/missing-test-ffmpeg', VIDEO_FFPROBE_PATH: '/missing-test-ffprobe',
      WECHAT_APP_ID: '', WECHAT_APP_SECRET: '', WECHAT_APPID: '', WECHAT_APPSECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${origin}/api/private-videos/access`)).status === 200) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error('Fixture server exited before readiness');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated fixture server ready');
  const request = (url, options = {}) => fetch(origin + url, { redirect: 'manual', ...options });
  const bodyHeaders = { Origin: origin, 'Content-Type': 'application/json' };
  const access = (code, extra = {}) => request('/api/private-videos/access', { method: 'POST', headers: { ...bodyHeaders, ...extra }, body: JSON.stringify({ code }) });
  const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
  const base = `/api/private-videos/${id}`;
  for (const resource of ['/manifest', '/key', '/segments/0']) assert.equal((await request(base + resource)).status, 401);
  const login = await request('/api/admin/login', { method: 'POST', headers: bodyHeaders, body: JSON.stringify({ password: 'private-video-fixture-password' }) });
  assert.equal(login.status, 200);
  const adminCookie = cookieOf(login), adminHeaders = { ...bodyHeaders, Cookie: adminCookie };
  assert.equal((await request(base + '/key', { headers: { Cookie: adminCookie } })).status, 401, 'admin login alone cannot enter ordinary viewing');
  const adminManifest = await request(`/api/admin/private-videos/${id}/manifest`, { headers: adminHeaders });
  assert.equal(adminManifest.status, 200); assert.match(await adminManifest.text(), /\/api\/admin\/private-videos\//);
  assert.equal((await request(`/api/admin/private-videos/${id}/key`)).status, 401);
  assert.equal((await request('/api/admin/video-access-codes')).status, 401);
  assert.equal((await request('/api/admin/video-access-codes', { method: 'POST', headers: { ...adminHeaders, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  const created = await request('/api/admin/video-access-codes', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ label: '合成测试观看者' }) });
  assert.equal(created.status, 201);
  const issued = await created.json();
  const listText = await (await request('/api/admin/video-access-codes', { headers: adminHeaders })).text();
  assert.ok(!listText.includes(issued.code)); assert.ok(!listText.includes('code_hash'));
  assert.equal((await access(issued.code, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await access('wrong-code')).status, 401);
  const first = await access(issued.code); assert.equal(first.status, 200);
  assert.match(first.headers.get('set-cookie'), /HttpOnly/); assert.match(first.headers.get('set-cookie'), /Max-Age=2592000/);
  const firstCookie = cookieOf(first), secondCookie = cookieOf(await access(issued.code));
  assert.notEqual(firstCookie, secondCookie);
  for (const cookie of [firstCookie, secondCookie]) {
    for (const assetId of [id, secondId]) {
      const response = await request(`/api/private-videos/${assetId}/manifest`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
      const text = await response.text();
      assert.ok(text.includes(`/api/private-videos/${assetId}/key`));
      assert.ok(text.includes(`/api/private-videos/${assetId}/segments/0`));
      assert.doesNotMatch(text, /aliyuncs|wrappedKey|signature|BEGIN/);
    }
  }
  const keyResponse = await request(base + '/key', { headers: { Cookie: firstCookie } });
  assert.equal(keyResponse.status, 200); assert.match(keyResponse.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await keyResponse.arrayBuffer()), key);
  assert.equal((await request(base + '/segments/999', { headers: { Cookie: firstCookie } })).status, 404);
  assert.equal((await request(base + '/segments/0', { headers: { Cookie: firstCookie } })).status, 503, 'missing OSS config fails without plaintext fallback');
  const content = `<p>合成测试视频，不包含真实用户内容。</p><video data-private-video-id="${id}" title="Synthetic fixture"></video>`;
  const publish = articleContent => request('/api/admin/articles', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ title: '私密视频功能测试', summary: '测试文章', content: articleContent, status: 'published' }) });
  const publication = await publish(content); assert.equal(publication.status, 201);
  const article = (await publication.json()).article;
  assert.equal((await publish(`<video data-private-video-id="${randomUUID()}"></video>`)).status, 422);
  assert.equal((await publish(`<video data-private-video-id="${id}" src="https://fixture-media.example/article-videos/${id}/video.mp4"></video>`)).status, 422);
  assert.equal((await publish(`<video src="https://fixture-media.example/article-videos/${id}/video.mp4"></video>`)).status, 201, 'legacy published MP4 retained');
  const remote = await request(`/api/admin/articles/${article.id}/sync`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ remoteServer: origin }) });
  assert.match((await remote.json()).remoteSync.detail, /HTTPS/);
  const syncPath = '/api/article-sync/private-videos';
  assert.equal((await request(syncPath)).status, 401);
  assert.equal((await request(syncPath, { headers: { Authorization: `Bearer ${syncSecret}` } })).status, 400);
  const caps = await request(syncPath, { headers: { Authorization: `Bearer ${syncSecret}`, 'X-Forwarded-Proto': 'https' } });
  assert.equal(caps.status, 503, 'receiver missing OSS configuration does not advertise readiness'); const capabilityText = await caps.text();
  assert.match(capabilityText, /配置/); assert.ok(!capabilityText.includes(master)); assert.ok(!capabilityText.includes('PRIVATE KEY'));
  assert.equal((await request('/api/private-videos/access', { method: 'DELETE', headers: { ...bodyHeaders, Cookie: firstCookie } })).status, 200);
  assert.equal((await request(base + '/key', { headers: { Cookie: firstCookie } })).status, 401);
  assert.equal((await request(base + '/key', { headers: { Cookie: secondCookie } })).status, 200, 'logout one device only');
  assert.equal((await request(`/api/admin/video-access-codes/${issued.accessCode.id}`, { method: 'DELETE', headers: adminHeaders })).status, 200);
  for (const cookie of [firstCookie, secondCookie]) assert.equal((await request(base + '/key', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await access(issued.code)).status, 401);
  assert.ok(!logs.includes(master)); assert.ok(!logs.includes(issued.code)); assert.ok(!logs.includes(syncSecret));
  if (process.env.PRIVATE_VIDEO_UI_REVIEW === '1' && process.stdin.isTTY) {
    console.log(`Synthetic UI fixture: ${origin}/ops-7q4m/videos`);
    console.log(`Editor: ${origin}/ops-7q4m/editor?id=${article.id}`);
    console.log('Test-only password: private-video-fixture-password. Press Enter to clean up.');
    process.stdin.resume(); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause();
  }
});
