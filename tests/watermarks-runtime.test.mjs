import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fixture } from './watermarks.test.mjs';

test('admin watermark API: access control, preservation, live image serving and no publication', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wangs-watermark-test-'));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(), env: { ...process.env, ADMIN_PASSWORD: 'watermark-fixture-password', ADMIN_SESSION_SECRET: 'watermark-fixture-session-secret', LOCATION_DB_PATH: path.join(directory, 'test.sqlite'), WATERMARK_TEMPLATE_DIR: path.join(directory, 'templates') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', rawDirectory, processedDirectory, manifestDirectory;
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (rawDirectory) await rm(rawDirectory, { recursive: true, force: true });
    if (processedDirectory) await rm(processedDirectory, { recursive: true, force: true });
    if (manifestDirectory) await rm(manifestDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const endpoint = `${origin}/api/admin/articles/watermarks`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'watermark-fixture-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const post = (body, extra = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await (await fetch(endpoint, { headers })).json()).settings, null);
  const created = await fetch(`${origin}/api/admin/articles`, { method: 'POST', headers, body: JSON.stringify({ title: '图片去水印功能测试', summary: '仅供本地测试，不发布、不上传', content: '<p>测试正文</p>', status: 'draft' }) });
  const article = (await created.json()).article;
  assert.ok(article?.id);
  const f = await fixture();
  const filename = `${createHash('sha256').update(f.input).digest('hex').slice(0, 24)}.png`;
  rawDirectory = path.join(process.cwd(), 'public', 'uploads', 'articles', article.id);
  processedDirectory = path.join(process.cwd(), 'public', 'article-images', article.id);
  manifestDirectory = path.join(process.cwd(), 'data', 'watermark-manifests', article.id);
  await mkdir(rawDirectory, { recursive: true });
  await writeFile(path.join(rawDirectory, filename), f.input);
  const source = `/uploads/articles/${article.id}/${filename}`;
  const content = `<p>这是测试图片，去水印不会自动修改或发布正文。</p><img src="${source}">`;
  const savedResponse = await fetch(`${origin}/api/admin/articles/${article.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...article, content }) });
  const saved = (await savedResponse.json()).article;
  const settings = { ...f.settings, template: f.template.toString('base64') };
  const body = { action: 'process', authorized: true, articleId: article.id, source, content, settings };
  assert.equal((await post(body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post({ ...body, authorized: false })).status, 422);
  assert.equal((await post({ ...body, content: '<p>no image</p>' })).status, 422);
  assert.equal((await post({ ...body, content: `<img src="${source}">`.repeat(101) })).status, 422);
  for (const count of [69, 100]) {
    const accepted = await post({ ...body, content: `<img src="${source}">`.repeat(count) });
    assert.equal(accepted.status, 200, `${count} image tags must pass the new limit`);
    assert.equal((await accepted.json()).status, 'processed');
  }
  for (const invalid of ['http://127.0.0.1/secret.png', `/uploads/articles/${crypto.randomUUID()}/${filename}`, `/uploads/articles/${article.id}/../../.env.local`, `/article-images/${article.id}/${filename}`]) {
    assert.equal((await post({ ...body, source: invalid, content: `<img src="${invalid}">` })).status, 422);
  }
  const calibrated = await post({ ...body, action: 'calibrate', region: [f.left / f.width, f.top / f.height, f.tw / f.width, f.th / f.height] });
  assert.equal(calibrated.status, 200);
  assert.ok((await calibrated.json()).settings.template);
  assert.equal((await post({ action: 'save-template', authorized: true, settings })).status, 200);
  const processed = await post(body);
  assert.equal(processed.status, 200);
  const result = await processed.json();
  assert.equal(result.status, 'processed', JSON.stringify(result));
  assert.match(result.localUrl, new RegExp(`^/article-images/${article.id}/[0-9a-f]{24}\\.png$`));
  const image = await fetch(origin + result.localUrl);
  assert.equal(image.status, 200, 'New images must be visible without restarting Next');
  assert.equal(image.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await image.arrayBuffer());
  const outputName = result.localUrl.split('/').at(-1);
  assert.deepEqual(bytes, await readFile(path.join(processedDirectory, outputName)));
  assert.deepEqual(await readFile(path.join(rawDirectory, filename)), f.input);
  const manifestName = outputName.replace('.png', '.json');
  assert.equal((await fetch(`${origin}/article-images/${article.id}/${manifestName}`)).status, 404);
  const manifest = JSON.parse(await readFile(path.join(manifestDirectory, manifestName), 'utf8'));
  assert.equal(manifest.sourceHash, createHash('sha256').update(f.input).digest('hex'));
  assert.equal(manifest.outputHash, createHash('sha256').update(bytes).digest('hex'));
  const articles = await (await fetch(`${origin}/api/admin/articles`, { headers })).json();
  assert.deepEqual(articles.articles.find(a => a.id === article.id), saved, 'Processing cannot save or publish the article');
  assert.equal((await fetch(`${origin}/articles/${article.id}`)).status, 404);
  const concurrent = await Promise.all([post(body), post(body)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 429]);
  if (process.env.WATERMARK_UI_REVIEW === '1') {
    console.log(`UI fixture: http://localhost:${port}/ops-7q4m/editor?id=${article.id}`);
    console.log('Fixture-only login: watermark-fixture-password. Press Enter here after UI checks.');
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
});
