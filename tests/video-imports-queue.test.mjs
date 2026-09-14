import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createPairing, validPairing, consumePairing, createVideoJobs, getVideoJob, cancelVideoJob, videoFile, validateBatch } from '../lib/video-imports.mjs';

test('persistent queue: one-at-a-time, cancellation, success, fallback and secret-free records', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-queue-'));
  const binary = path.join(directory, 'fixture-tool');
  await copyFile(new URL('./fixtures/video-tool.mjs', import.meta.url), binary); await chmod(binary, 0o700);
  const previous = { VIDEO_IMPORT_DIR: process.env.VIDEO_IMPORT_DIR, VIDEO_FFMPEG_PATH: process.env.VIDEO_FFMPEG_PATH, VIDEO_FFPROBE_PATH: process.env.VIDEO_FFPROBE_PATH };
  process.env.VIDEO_IMPORT_DIR = path.join(directory, 'tasks'); process.env.VIDEO_FFMPEG_PATH = binary; process.env.VIDEO_FFPROBE_PATH = binary;
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const pair = createPairing(); assert.equal(validPairing(pair.token), true); consumePairing(pair.token); assert.equal(validPairing(pair.token), false);
  let concurrent = 0, maximum = 0;
  const requests = [];
  t.mock.method(http, 'get', (url, options, callback) => {
    requests.push(url.pathname);
    const request = new EventEmitter(); request.setTimeout = () => {};
    concurrent++; maximum = Math.max(maximum, concurrent);
    const timer = setTimeout(() => {
      concurrent--;
      const ts = Buffer.alloc(376); ts[0] = 0x47; ts[188] = 0x47;
      const body = url.pathname.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST') : ts;
      const response = Readable.from([body]); response.statusCode = url.pathname.includes('missing') ? 404 : 200; response.headers = {}; callback(response);
    }, 25);
    request.destroy = () => { clearTimeout(timer); };
    options.signal.addEventListener('abort', () => { clearTimeout(timer); concurrent--; request.emit('error', new Error('aborted')); }, { once: true });
    return request;
  });
  const videos = validateBatch({ authorized: true, videos: [
    { title: 'Success', url: 'http://8.8.8.8/one.m3u8?auth_key=SECRET' },
    { title: 'Cancelled', url: 'http://8.8.8.8/cancelled.m3u8?auth_key=SECRET' },
    { title: 'Fallback', url: 'http://8.8.8.8/missing.m3u8?auth_key=SECRET', backupUrl: 'http://8.8.8.8/backup.m3u8?auth_key=SECRET' },
  ] });
  const jobs = await createVideoJobs(videos); cancelVideoJob(jobs[1].id);
  for (let i = 0; i < 200; i++) {
    if (['completed', 'failed'].includes(getVideoJob(jobs[2].id).status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(getVideoJob(jobs[0].id).status, 'completed', JSON.stringify(getVideoJob(jobs[0].id)));
  assert.equal(getVideoJob(jobs[1].id).status, 'cancelled');
  assert.equal(getVideoJob(jobs[2].id).status, 'completed', JSON.stringify(getVideoJob(jobs[2].id)));
  assert.match(getVideoJob(jobs[2].id).notice, /备用线路/);
  assert.equal(maximum, 1); assert.ok(!requests.includes('/cancelled.m3u8'));
  assert.equal(await readFile(videoFile(jobs[0].id), 'utf8'), 'fixture-only-mp4');
  assert.equal(videoFile(jobs[1].id), null);
  // Completion metadata is saved before cleanup; wait for that bounded cleanup before removing the fixture root.
  for (let i = 0; i < 100; i++) {
    if (!(await readdir(path.join(process.env.VIDEO_IMPORT_DIR, jobs[2].id))).includes('work')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (const job of jobs) {
    const record = await readFile(path.join(process.env.VIDEO_IMPORT_DIR, job.id, 'result.json'), 'utf8');
    assert.ok(!record.includes('SECRET') && !record.includes('auth_key'));
    assert.ok(!(await readdir(path.join(process.env.VIDEO_IMPORT_DIR, job.id))).includes('work'));
  }
  // Cancel an actively downloading request, not just a queued job.
  const [running] = await createVideoJobs(validateBatch({ authorized: true, videos: [{ url: 'http://8.8.8.8/running.m3u8' }] }));
  await new Promise(resolve => setTimeout(resolve, 5)); cancelVideoJob(running.id);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(getVideoJob(running.id).status, 'cancelled'); assert.equal(videoFile(running.id), null);
  assert.ok(!(await readdir(path.join(process.env.VIDEO_IMPORT_DIR, running.id))).includes('work'));
});
