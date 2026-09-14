import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { getVideoJob, listVideoJobs } from '../lib/video-imports.mjs';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../lib/article-video-urls.ts', import.meta.url), 'utf8');
const urlModule = `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`;
const urls = await import(urlModule);
const ossSource = (await readFile(new URL('../lib/oss-videos.ts', import.meta.url), 'utf8'))
  .replace('from "ali-oss"', `from ${JSON.stringify(pathToFileURL(require.resolve('ali-oss')).href)}`)
  .replace('from "./article-video-urls"', `from ${JSON.stringify(urlModule)}`)
  .replace('from "./video-download.mjs"', `from ${JSON.stringify(new URL('../lib/video-download.mjs', import.meta.url).href)}`)
  .replace('from "./video-imports.mjs"', `from ${JSON.stringify(new URL('../lib/video-imports.mjs', import.meta.url).href)}`);
const oss = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(ossSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`);
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const keys = ['OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_PUBLIC_BASE_URL', 'OSS_ARTICLE_VIDEO_PREFIX', 'OSS_CNAME', 'VIDEO_IMPORT_DIR'];

async function fixture(t, jobs = [{ id: ID }]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-oss-'));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { VIDEO_IMPORT_DIR: directory, OSS_BUCKET: 'fixture-bucket', OSS_REGION: 'oss-cn-hangzhou', OSS_ACCESS_KEY_ID: 'fixture-access-key', OSS_ACCESS_KEY_SECRET: 'fixture-secret-do-not-log' });
  delete globalThis[Symbol.for('shenxiang.video-imports.v1')];
  delete globalThis[Symbol.for('shenxiang.video-oss-queue.v1')];
  for (const item of jobs) {
    const job = { title: 'Synthetic fixture', sourceHost: 'fixture.invalid', createdAt: Date.now(), status: 'completed', downloaded: 1, total: 1, bytes: 24, fileBytes: 24, ...item };
    const jobPath = path.join(directory, job.id);
    await mkdir(jobPath);
    await writeFile(path.join(jobPath, 'video.mp4'), Buffer.alloc(24, 42));
    await writeFile(path.join(jobPath, 'result.json'), JSON.stringify(job));
  }
  t.after(async () => {
    delete globalThis[Symbol.for('shenxiang.video-imports.v1')];
    delete globalThis[Symbol.for('shenxiang.video-oss-queue.v1')];
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const published = id => ({ status: 'uploaded', progress: 100, url: `${urls.ossArticleVideoBaseUrl()}/${id}/video.mp4`, objectKey: `article-videos/${id}/video.mp4`, uploadedAt: Date.now() });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for synthetic queue');
}

test('permanent OSS video URL policy rejects foreign, local, signed and malformed sources', async t => {
  await fixture(t);
  const base = 'https://fixture-bucket.oss-accelerate.aliyuncs.com/article-videos';
  assert.equal(urls.ossArticleVideoBaseUrl(), base);
  assert.equal(urls.isOssArticleVideoSource(`${base}/${ID}/video.mp4`), true);
  for (const value of [
    `${base}/${ID}/video.mp4?auth_key=secret`, `${base}/${ID}/video.mp4#x`, `${base}/${ID}/other.mp4`,
    `${base}/${ID}/../video.mp4`, `${base}/${ID}%2Fvideo.mp4`, `${base}/${ID}/video.mp4/`,
    `http://fixture-bucket.oss-accelerate.aliyuncs.com/article-videos/${ID}/video.mp4`,
    `https://evil.example/article-videos/${ID}/video.mp4`, `https://fixture-bucket.oss-accelerate.aliyuncs.com.evil.example/article-videos/${ID}/video.mp4`,
    `/api/admin/video-imports/${ID}/file`, 'blob:https://example.com/abc',
  ]) assert.equal(urls.isOssArticleVideoSource(value), false, value);
  process.env.OSS_PUBLIC_BASE_URL = 'https://cdn.example.com/media'; process.env.OSS_ARTICLE_VIDEO_PREFIX = '/my-videos/';
  assert.equal(urls.ossArticleVideoBaseUrl(), 'https://cdn.example.com/media/my-videos');
  for (const value of ['https://127.0.0.1', 'https://localhost', 'https://127.1', 'https://[::1]', 'https://169.254.169.254', 'https://192.168.1.2', 'https://user:pass@cdn.example.com', 'https://cdn.example.com?token=x', 'https://cdn.example.com/x/../y', 'https://cdn.example.com/%2e', 'http://cdn.example.com']) {
    process.env.OSS_PUBLIC_BASE_URL = value; assert.equal(urls.ossArticleVideoBaseUrl(), null, value);
  }
  process.env.OSS_PUBLIC_BASE_URL = 'https://cdn.example.com';
  for (const value of ['../video', 'video//files', 'video?key=x']) { process.env.OSS_ARTICLE_VIDEO_PREFIX = value; assert.equal(urls.ossArticleVideoBaseUrl(), null); }
});

test('multipart uploader uses a private filepath, bounded single-part concurrency and verified permanent URL', async t => {
  const directory = await fixture(t);
  const progress = [], calls = [];
  const job = getVideoJob(ID);
  const result = await oss.uploadVideoFileToOss(job, {
    progress: value => progress.push(value),
    createClient: config => {
      assert.equal(config.authorizationV4, true); assert.equal(config.timeout, 60000); assert.equal(config.retryMax, 2);
      return {
        multipartUpload: async (key, file, options) => {
          calls.push(key); assert.equal(file, path.join(directory, ID, 'video.mp4')); assert.equal(typeof file, 'string');
          assert.equal(options.parallel, 1); assert.equal(options.partSize, 8 * 1024 * 1024); assert.equal(options.mime, 'video/mp4');
          assert.equal(options.headers['Content-Disposition'], 'inline'); assert.ok(!JSON.stringify(options).includes('x-oss-object-acl'));
          await options.progress(0.5, { uploadId: 'fixture-upload-secret' }); await options.progress(1);
          return {};
        }, cancel() { assert.fail('successful upload should not cancel'); }, abortMultipartUpload() { assert.fail('successful upload should not abort'); },
      };
    },
    verifyPublic: async (url, bytes) => { calls.push('verify'); assert.equal(url, published(ID).url); assert.equal(bytes, 24); },
  });
  assert.deepEqual(progress, [50, 99]); assert.equal(calls.length, 2); assert.equal(result.status, 'uploaded'); assert.equal(result.progress, 100);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal((await readFile(path.join(directory, ID, 'video.mp4'))).length, 24);
});

test('failed multipart aborts only its upload, redacts SDK details and retains local video', async t => {
  const directory = await fixture(t);
  let cancelled = 0; const aborts = [];
  await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), {
    createClient: () => ({
      multipartUpload: async (key, file, options) => { await options.progress(0.2, { uploadId: 'fixture-upload-secret' }); throw Object.assign(new Error('https://host?secret=TOPSECRET'), { code: 'AccessDenied' }); },
      cancel() { cancelled++; }, abortMultipartUpload: async (...args) => { aborts.push(args); },
    }),
    verifyPublic: async () => assert.fail('must not verify failed upload'),
  }), error => /OSS 拒绝上传/.test(error.message) && !/TOPSECRET|fixture-upload-secret/.test(error.message));
  assert.equal(cancelled, 1); assert.deepEqual(aborts, [[`article-videos/${ID}/video.mp4`, 'fixture-upload-secret', { timeout: 15000 }]]);
  assert.equal((await readFile(path.join(directory, ID, 'video.mp4'))).length, 24);
});

test('public-link failure does not delete completed OSS object; timeout cancels and cleans parts', async t => {
  await fixture(t);
  const client = { multipartUpload: async () => ({}), cancel() {}, abortMultipartUpload: async () => assert.fail('completed object must not be aborted') };
  t.mock.method(globalThis, 'fetch', async (url, options) => { assert.equal(options.method, 'HEAD'); assert.equal(options.redirect, 'error'); return new Response(null, { status: 403 }); });
  await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), { createClient: () => client }), /无法匿名读取/);
  let release; let aborted = false;
  await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), {
    timeoutMs: 10,
    createClient: () => ({
      multipartUpload: async (key, file, options) => { await options.progress(0, { uploadId: 'timeout-fixture' }); await new Promise((resolve, reject) => { release = reject; }); },
      cancel() { release?.(new Error('cancelled')); }, abortMultipartUpload: async () => { aborted = true; },
    }), verifyPublic: async () => assert.fail('timeout cannot publish'),
  }), /超过 30 分钟/);
  assert.equal(aborted, true);
});

test('file checks reject symlinks, missing or changed MP4 before any client is created', async t => {
  const directory = await fixture(t);
  const file = path.join(directory, ID, 'video.mp4');
  const config = { createClient: () => assert.fail('invalid local file must not create OSS client') };
  await writeFile(file, Buffer.alloc(25)); await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), config), /文件已改变/);
  await rm(file); await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), config), /本地完整视频/);
  const target = path.join(directory, 'other.mp4'); await writeFile(target, Buffer.alloc(24)); await symlink(target, file);
  await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), config), /本地完整视频/);
});

test('OSS queue serializes, deduplicates, retries failures and persists only safe publication metadata', async t => {
  const directory = await fixture(t, [{ id: ID }, { id: SECOND }]);
  let active = 0, max = 0, calls = 0;
  const upload = async (job, { progress }) => {
    active++; max = Math.max(max, active); calls++; progress(25);
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    if (job.id === SECOND && calls === 2) throw new Error('https://secret.invalid?auth_key=PRIVATE');
    return published(job.id);
  };
  assert.throws(() => oss.enqueueVideoOssUpload(ID, false, upload), /确认/);
  assert.equal(oss.enqueueVideoOssUpload('missing', true, upload), null);
  const first = oss.enqueueVideoOssUpload(ID, true, upload); assert.equal(first.publication.status, 'uploading');
  assert.equal(oss.enqueueVideoOssUpload(ID, true, upload), first);
  oss.enqueueVideoOssUpload(SECOND, true, upload);
  await until(() => getVideoJob(SECOND).publication.status === 'failed');
  assert.equal(max, 1); assert.equal(calls, 2); assert.equal(first.publication.status, 'uploaded');
  oss.enqueueVideoOssUpload(ID, true, upload); assert.equal(calls, 2);
  assert.ok(!getVideoJob(SECOND).publication.error.includes('PRIVATE'));
  oss.enqueueVideoOssUpload(SECOND, true, upload); await until(() => getVideoJob(SECOND).publication.status === 'uploaded');
  assert.equal(calls, 3);
  for (const id of [ID, SECOND]) {
    const saved = await readFile(path.join(directory, id, 'result.json'), 'utf8');
    assert.ok(!/PRIVATE|fixture-secret|fixture-access|uploadId|auth_key/.test(saved));
    assert.equal(JSON.parse(saved).publication.status, 'uploaded');
    assert.equal((await readFile(path.join(directory, id, 'video.mp4'))).length, 24);
  }
});

test('configuration gates, queue bound and restart recovery preserve completed videos', async t => {
  const jobs = Array.from({ length: 13 }, (_, index) => ({ id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  jobs[0].publication = { status: 'uploading', progress: 75 };
  await fixture(t, jobs);
  const restored = listVideoJobs();
  assert.equal(getVideoJob(jobs[0].id).status, 'completed'); assert.equal(getVideoJob(jobs[0].id).publication.status, 'failed');
  assert.match(getVideoJob(jobs[0].id).publication.error, /服务重启/);
  delete process.env.OSS_ACCESS_KEY_SECRET;
  assert.equal(oss.videoOssStatus().ready, false); assert.match(oss.videoOssStatus().message, /OSS_ACCESS_KEY_SECRET/);
  assert.throws(() => oss.enqueueVideoOssUpload(jobs[0].id, true), /OSS_ACCESS_KEY_SECRET/);
  process.env.OSS_ACCESS_KEY_SECRET = 'fixture-secret';
  let release; const hold = new Promise(resolve => { release = resolve; });
  const upload = async job => { await hold; return published(job.id); };
  for (const job of restored.slice(0, 12)) oss.enqueueVideoOssUpload(job.id, true, upload);
  assert.throws(() => oss.enqueueVideoOssUpload(restored[12].id, true, upload), /队列已满/);
  release(); await until(() => restored.slice(0, 12).every(job => job.publication.status === 'uploaded'));
});
