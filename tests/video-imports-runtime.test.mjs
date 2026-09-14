import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('video APIs: auth, CSRF, pairing, private range downloads, restart recovery and missing dependencies', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wangs-video-api-'));
  const root = path.join(directory, 'videos'); await mkdir(root);
  const completed = randomUUID(), interrupted = randomUUID();
  for (const [id, status] of [[completed, 'completed'], [interrupted, 'downloading']]) {
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'result.json'), JSON.stringify({ id, status, title: '合成接口测试', sourceHost: 'media.example', createdAt: Date.now(), bytes: 10, downloaded: 1, total: 1, error: '' }));
  }
  await writeFile(path.join(root, completed, 'video.mp4'), '0123456789');
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, ADMIN_PASSWORD: 'video-fixture-only-password', ADMIN_SESSION_SECRET: 'video-fixture-only-session-secret', VIDEO_IMPORT_DIR: root, VIDEO_FFMPEG_PATH: '/missing-fixture-ffmpeg', VIDEO_FFPROBE_PATH: '/missing-fixture-ffprobe', LOCATION_DB_PATH: path.join(directory, 'test.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/ops-7q4m/videos`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  assert.equal((await fetch(`${origin}/shenxiang-video-importer.user.js`)).status, 200);
  for (const endpoint of ['/api/admin/video-imports', `/api/admin/video-imports/${completed}`, `/api/admin/video-imports/${completed}/file`]) assert.equal((await fetch(origin + endpoint)).status, 401);
  assert.equal((await fetch(`${origin}/api/admin/video-imports/pair`, { method: 'POST' })).status, 401);
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'video-fixture-only-password' }) });
  assert.equal(login.status, 200);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, Origin: origin, 'Content-Type': 'application/json' };
  const post = (endpoint, body = {}, extra = {}) => fetch(origin + endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const list = await fetch(`${origin}/api/admin/video-imports`, { headers });
  assert.equal(list.status, 200);
  const initial = await list.json();
  assert.equal(initial.tools.ready, false); assert.match(initial.tools.message, /手动安装/);
  assert.equal(initial.jobs.find(job => job.id === interrupted).status, 'failed');
  assert.match(initial.jobs.find(job => job.id === interrupted).error, /重启/);
  assert.equal((await post('/api/admin/video-imports/pair', {}, { Origin: 'https://other.example' })).status, 403);
  const paired = await post('/api/admin/video-imports/pair');
  const pair = await paired.json(); assert.equal(paired.status, 201, JSON.stringify(pair)); assert.ok(pair.token);
  assert.ok(!JSON.stringify(await (await fetch(`${origin}/api/admin/video-imports`, { headers })).json()).includes(pair.token));
  assert.equal((await post('/api/video-imports', {}, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post('/api/admin/video-imports', { authorized: true, videos: [{ url: 'http://127.0.0.1/secret' }] })).status, 422);
  const batch = { authorized: true, videos: [{ url: 'https://media.example/v.m3u8?auth_key=FIXTURE_SECRET' }] };
  const result = await post('/api/video-imports', batch, { Cookie: '', Authorization: `Bearer ${pair.token}` });
  assert.equal(result.status, 422); assert.match((await result.json()).error, /手动安装/);
  assert.equal((await post('/api/video-imports', batch, { Authorization: `Bearer ${pair.token}` })).status, 401, 'pair consumed before async creation');
  assert.equal((await post('/api/admin/video-imports', { padding: 'a'.repeat(64000) })).status, 422);
  assert.equal((await post(`/api/admin/video-imports/${randomUUID()}/cancel`)).status, 404);
  assert.equal((await post(`/api/admin/video-imports/${completed}/cancel`)).status, 200, 'terminal jobs are idempotent');
  const fileURL = `${origin}/api/admin/video-imports/${completed}/file`;
  const whole = await fetch(fileURL, { headers }); assert.equal(whole.status, 200); assert.equal(await whole.text(), '0123456789');
  assert.equal(whole.headers.get('cache-control'), 'private, no-store');
  for (const [range, expected] of [['bytes=2-4', '234'], ['bytes=-3', '789'], ['bytes=7-', '789']]) {
    const partial = await fetch(fileURL, { headers: { ...headers, Range: range } });
    assert.equal(partial.status, 206); assert.equal(await partial.text(), expected);
  }
  for (const range of ['bytes=100-', 'bytes=4-2', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-']) assert.equal((await fetch(fileURL, { headers: { ...headers, Range: range } })).status, 416);
  const attachment = await fetch(`${fileURL}?download=1`, { headers }); assert.match(attachment.headers.get('content-disposition'), /attachment/); await attachment.arrayBuffer();
  assert.equal((await fetch(`${origin}/data/video-imports/${completed}/video.mp4`)).status, 404);
  assert.equal((await fetch(`${origin}/api/admin/video-imports/${interrupted}/file`, { headers })).status, 404);
  assert.ok(!(await readFile(path.join(root, interrupted, 'result.json'), 'utf8')).includes('FIXTURE_SECRET'));
  assert.ok(!logs.includes('FIXTURE_SECRET'));
});
