import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { downloadVideo, VideoError, VideoTailError } from '../lib/video-download.mjs';

// Optional real-browser check. Uses only isolated metadata and synthetic bytes,
// never the user's database, media, credentials or OSS objects.
test('browser tail confirmation can be cancelled; explicit merge and discard update the real admin page', { timeout: 60000 }, async t => {
  if (!process.env.VIDEO_PLAYWRIGHT_MODULE) { t.skip('Set VIDEO_PLAYWRIGHT_MODULE to an installed Playwright package.'); return; }
  const { chromium } = createRequire(import.meta.url)(process.env.VIDEO_PLAYWRIGHT_MODULE);
  const directory = await mkdtemp(path.join(tmpdir(), 'video-tail-ui-'));
  const root = path.join(directory, 'jobs'), tool = path.join(directory, 'fixture-tool');
  await copyFile(new URL('./fixtures/video-tool.mjs', import.meta.url), tool); await chmod(tool, 0o700);
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const work = path.join(root, id, 'work'); await mkdir(work, { recursive: true });
    const fragment = Buffer.alloc(376); fragment[0] = 0x47; fragment[188] = 0x47;
    let recovery;
    await assert.rejects(downloadVideo('https://fixture.example/list.m3u8', work, { signal: AbortSignal.timeout(5000), progress() {}, fetcher: async url => {
      if (url.endsWith('/bad.ts')) throw new VideoError('网络连接失败（ECONNRESET）。');
      return { url, bytes: url.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ngood.ts\n#EXTINF:2,\nbad.ts\n#EXT-X-ENDLIST\n') : fragment };
    } }), error => { recovery = error.recovery; return error instanceof VideoTailError; });
    await writeFile(path.join(root, id, 'result.json'), JSON.stringify({ id, title: `Synthetic tail ${index}`, sourceHost: 'fixture.example', status: 'failed', createdAt: Date.now(), bytes: 376, downloaded: 1, total: 2, error: '尾段失败', tailRecovery: recovery }));
  }
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, VIDEO_IMPORT_DIR: root, VIDEO_FFMPEG_PATH: tool, VIDEO_FFPROBE_PATH: tool,
      ADMIN_PASSWORD: 'tail-ui-fixture-password', ADMIN_SESSION_SECRET: 'tail-ui-fixture-session-secret', LOCATION_DB_PATH: path.join(directory, 'fixture.sqlite'),
      OSS_BUCKET: '', OSS_REGION: '', OSS_ACCESS_KEY_ID: '', OSS_ACCESS_KEY_SECRET: '', PRIVATE_VIDEO_UPLOAD_ENABLED: 'false', WECHAT_APP_ID: '', WECHAT_APP_SECRET: '' },
    stdio: 'ignore',
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/admin/video-imports`)).status === 401) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated server must start');
  browser = await chromium.launch({ headless: true, ...(process.env.VIDEO_CHROME_PATH ? { executablePath: process.env.VIDEO_CHROME_PATH } : {}) });
  const context = await browser.newContext(), page = await context.newPage();
  const login = await context.request.post(`${origin}/api/admin/login`, { data: { password: 'tail-ui-fixture-password' } });
  assert.equal(login.status(), 200);
  const posts = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/tail')) posts.push(request.postDataJSON()); });
  await page.goto(`${origin}/ops-7q4m/videos`);
  const first = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic tail 0', exact: true }) });
  const merge = first.getByRole('button', { name: '忽略失败尾段并合成', exact: true });
  await merge.waitFor();
  assert.match(await first.innerText(), /待确认/);
  page.once('dialog', dialog => dialog.dismiss()); await merge.click();
  assert.equal(posts.length, 0, 'dismissing confirmation must not mutate a task');
  page.once('dialog', dialog => { assert.match(dialog.message(), /不是完整原视频/); return dialog.accept(); });
  await merge.click();
  await first.getByText('成功（缺少尾段）', { exact: true }).waitFor({ timeout: 15000 });
  assert.deepEqual(posts[0], { action: 'merge', confirmed: true });
  const download = await context.request.get(`${origin}/api/admin/video-imports/${ids[0]}/file?download=1`);
  assert.equal(download.status(), 200); assert.match(download.headers()['content-disposition'], /-incomplete\.mp4/);
  const second = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic tail 1', exact: true }) });
  page.once('dialog', dialog => dialog.accept());
  await second.getByRole('button', { name: '丢弃保留分片', exact: true }).click();
  await second.getByText('已手动丢弃保留分片；如需保存视频，请从来源页面重新提交。', { exact: true }).waitFor();
  assert.deepEqual(posts[1], { action: 'discard', confirmed: true });
  assert.equal(await second.getByRole('button', { name: '忽略失败尾段并合成', exact: true }).count(), 0);
});
