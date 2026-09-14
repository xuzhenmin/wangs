import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('article videos: draft, publish, sanitized public content, OSS-only remote sync and upload authorization', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wangs-article-video-api-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const videoRoot = path.join(directory, 'videos');
  const videoId = randomUUID(), legacyId = randomUUID();
  const publicBase = 'https://video-fixture.example';
  const videoBase = `${publicBase}/article-videos`;
  const videoUrl = `${videoBase}/${videoId}/video.mp4`;
  const safeVideo = `<video src="${videoUrl}" controls playsinline preload="metadata"></video>`;
  await mkdir(path.join(videoRoot, videoId), { recursive: true });
  await writeFile(path.join(videoRoot, videoId, 'result.json'), JSON.stringify({ id: videoId, title: '合成视频', sourceHost: 'fixture.example', status: 'completed', createdAt: 1000, downloaded: 1, total: 1, bytes: 24, fileBytes: 24, error: '' }));
  await writeFile(path.join(videoRoot, videoId, 'video.mp4'), Buffer.from('\x00\x00\x00\x18ftypisom'));
  if (process.env.ARTICLE_VIDEOS_UI_REVIEW === '1') {
    const uiVideoId = randomUUID();
    await mkdir(path.join(videoRoot, uiVideoId));
    await writeFile(path.join(videoRoot, uiVideoId, 'result.json'), JSON.stringify({ id: uiVideoId, title: '界面验证视频（合成记录）', sourceHost: 'fixture.example', status: 'completed', createdAt: 2000, downloaded: 1, total: 1, bytes: 24, fileBytes: 24, error: '',
      publication: { status: 'uploaded', progress: 100, url: `${videoBase}/${uiVideoId}/video.mp4`, objectKey: `article-videos/${uiVideoId}/video.mp4`, uploadedAt: 2000 } }));
    await writeFile(path.join(videoRoot, uiVideoId, 'video.mp4'), Buffer.from('\x00\x00\x00\x18ftypisom'));
  }
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT, summary TEXT, content TEXT, status TEXT, created_at INTEGER, updated_at INTEGER)');
  legacy.prepare('INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?, ?)').run(legacyId, '旧格式安全测试', '',
    `<p>before</p><video src="${videoUrl}" autoplay loop muted onplay="alert(1)" poster="https://untrusted.example/a.jpg"><source src="https://untrusted.example/v.mp4"><script>alert(2)</script></video><video src="/api/admin/video-imports/${videoId}/file"></video><video src="https://untrusted.example/v.mp4"></video><p>after</p>`, 'published', 1000, 2000);
  legacy.close();

  const remoteBodies = [];
  const remote = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { remoteBodies.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); });
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const remoteOrigin = `http://127.0.0.1:${remote.address().port}`;
  const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const syncSecret = 'article-video-fixture-sync-secret-32';
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, LOCATION_DB_PATH: databasePath, VIDEO_IMPORT_DIR: videoRoot,
      ADMIN_PASSWORD: 'article-video-fixture-password', ADMIN_SESSION_SECRET: 'article-video-fixture-session-secret',
      ARTICLE_SYNC_SECRET: syncSecret, ARTICLE_SYNC_ALLOW_PRIVATE: 'true',
      OSS_PUBLIC_BASE_URL: publicBase, OSS_ARTICLE_VIDEO_PREFIX: 'article-videos', OSS_BUCKET: 'test-bucket', OSS_REGION: 'oss-cn-hangzhou',
      OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '', OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
      VIDEO_FFMPEG_PATH: '/missing-fixture-tool', VIDEO_FFPROBE_PATH: '/missing-fixture-tool' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await new Promise(resolve => remote.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/ops-7q4m/editor`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const ossPath = `/api/admin/video-imports/${videoId}/oss`;
  assert.equal((await fetch(origin + ossPath, { method: 'POST' })).status, 401);
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'article-video-fixture-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
  const send = (route, body, method = 'POST', extra = {}) => fetch(origin + route, { method, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const articleList = await (await fetch(`${origin}/api/admin/articles`, { headers })).json();
  assert.equal(articleList.articleVideoBaseUrl, videoBase);
  const library = await (await fetch(`${origin}/api/admin/video-imports`, { headers })).json();
  assert.equal(library.articleVideoBaseUrl, videoBase);
  assert.equal(library.oss.ready, false);
  assert.equal((await send(ossPath, { authorized: true }, 'POST', { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await send(ossPath, { authorized: false })).status, 422);
  const missingConfig = await send(ossPath, { authorized: true });
  assert.equal(missingConfig.status, 422);
  assert.match((await missingConfig.json()).error, /OSS|配置/);
  assert.deepEqual(await readFile(path.join(videoRoot, videoId, 'video.mp4')), Buffer.from('\x00\x00\x00\x18ftypisom'));

  const invalidContent = `<p>草稿保留</p><video src="/api/admin/video-imports/${videoId}/file"></video>`;
  const draft = await send('/api/admin/articles', { title: '视频草稿', summary: '', status: 'draft', content: invalidContent });
  assert.equal(draft.status, 201);
  const draftId = (await draft.json()).article.id;
  const rejectedPublish = await send(`/api/admin/articles/${draftId}`, { title: '视频草稿', summary: '', status: 'published', content: invalidContent }, 'PUT');
  assert.equal(rejectedPublish.status, 422); assert.match((await rejectedPublish.json()).detail, /视频.*上传|上传.*视频/);
  assert.equal((await send('/api/admin/articles', { title: '超限视频', summary: '', status: 'published', content: safeVideo.repeat(21) })).status, 422);

  const content = `<p>视频之前</p>${safeVideo}<p>视频之后</p>`;
  const publication = await send('/api/admin/articles', { title: '合成视频文章', summary: '可重复编辑', status: 'published', content });
  assert.equal(publication.status, 201);
  const article = (await publication.json()).article;
  const edited = await send(`/api/admin/articles/${article.id}`, { title: '合成视频文章更新', summary: '', status: 'published', content: content + '<p>已更新</p>' }, 'PUT');
  assert.equal(edited.status, 200); assert.match((await edited.json()).article.content, /<video/);
  const publicView = async id => {
    const response = await fetch(`${origin}/api/articles/${id}/view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID() }) });
    assert.equal(response.status, 200); return (await response.json()).content;
  };
  const displayed = await publicView(article.id);
  assert.ok(displayed.includes(videoUrl)); assert.match(displayed, /<video[^>]*controls[^>]*playsinline[^>]*preload="metadata"/);
  const sanitized = await publicView(legacyId);
  assert.equal((sanitized.match(/<video\b/g) || []).length, 1);
  assert.doesNotMatch(sanitized, /autoplay|onplay|muted|loop|poster|<source|<script|untrusted\.example|\/api\/admin/);
  assert.match(sanitized, /<p>before<\/p>/); assert.match(sanitized, /<p>after<\/p>/);

  const synced = await send(`/api/admin/articles/${article.id}/sync`, { remoteServer: remoteOrigin });
  assert.equal(synced.status, 200);
  const syncedBody = await synced.json(); assert.equal(syncedBody.remoteSync.status, 'synced', JSON.stringify(syncedBody.remoteSync));
  assert.equal(remoteBodies.length, 1); assert.deepEqual(Object.keys(remoteBodies[0]), ['article']);
  assert.ok(remoteBodies[0].article.content.includes(videoUrl));
  const receive = payload => fetch(`${origin}/api/article-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncSecret}` }, body: JSON.stringify(payload) });
  assert.equal((await receive({ article: { ...article, id: randomUUID() } })).status, 200);
  assert.equal((await receive({ article: { ...article, id: randomUUID(), content: invalidContent } })).status, 422);
  assert.equal((await receive({ article: { ...article, id: randomUUID(), content: `<video src="${videoUrl}?signature=EXPIRED"></video>` } })).status, 422);
  const current = (await (await fetch(`${origin}/api/admin/articles`, { headers })).json()).articles;
  assert.equal(current.find(item => item.id === draftId).status, 'draft');
  assert.equal((await readFile(path.join(videoRoot, videoId, 'result.json'), 'utf8')).includes('uploading'), false, 'article saves and sync never implicitly upload videos');
  assert.equal(logs.includes(syncSecret), false);
  if (process.env.ARTICLE_VIDEOS_UI_REVIEW === '1') {
    console.log(`Article video UI fixture: ${origin}/ops-7q4m/editor?id=${draftId}`);
    console.log('Fixture-only password: article-video-fixture-password. Press Enter to clean up.');
    process.stdin.resume(); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause();
  }
});
