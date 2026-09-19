import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { getVideoJob, listVideoJobs } from '../lib/video-imports.mjs';
import { loadTs } from './helpers/load-typescript.mjs';

const urls = loadTs('../lib/article-video-urls.ts', import.meta.url);
const oss = loadTs('../lib/oss-videos.ts', import.meta.url);
const storage = loadTs('../lib/oss-private-videos.ts', import.meta.url);
const ID = '11111111-1111-4111-8111-111111111111', SECOND = '22222222-2222-4222-8222-222222222222';
const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
const keys = ['OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_PUBLIC_BASE_URL', 'OSS_ARTICLE_VIDEO_PREFIX', 'OSS_ARTICLE_IMAGE_PREFIX', 'OSS_CNAME', 'VIDEO_IMPORT_DIR', 'PRIVATE_VIDEO_UPLOAD_ENABLED', 'PRIVATE_VIDEO_MASTER_KEY', 'PRIVATE_VIDEO_OSS_PREFIX'];

async function fixture(t, jobs = [{ id: ID }]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-oss-'));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { VIDEO_IMPORT_DIR: directory, OSS_BUCKET: 'fixture-bucket', OSS_REGION: 'oss-cn-hangzhou', OSS_ACCESS_KEY_ID: 'fixture-access-key', OSS_ACCESS_KEY_SECRET: 'fixture-secret-do-not-log', PRIVATE_VIDEO_UPLOAD_ENABLED: 'true', PRIVATE_VIDEO_MASTER_KEY: randomBytes(32).toString('base64') });
  delete globalThis[Symbol.for('shenxiang.video-imports.v1')]; delete globalThis[Symbol.for('shenxiang.video-oss-queue.v1')];
  for (const item of jobs) {
    const job = { title: 'Synthetic fixture', sourceHost: 'fixture.invalid', createdAt: Date.now(), status: 'completed', downloaded: 1, total: 1, bytes: 24, fileBytes: 24, ...item };
    const jobPath = path.join(directory, job.id); await mkdir(jobPath);
    await writeFile(path.join(jobPath, 'video.mp4'), Buffer.alloc(24, 42));
    await writeFile(path.join(jobPath, 'result.json'), JSON.stringify(job));
  }
  t.after(async () => {
    delete globalThis[Symbol.for('shenxiang.video-imports.v1')]; delete globalThis[Symbol.for('shenxiang.video-oss-queue.v1')];
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const publicResult = id => ({ status: 'uploaded', progress: 100, url: `${urls.ossArticleVideoBaseUrl()}/${id}/video.mp4`, objectKey: `article-videos/${id}/video.mp4`, uploadedAt: Date.now() });
const privateResult = id => ({ kind: 'private', assetId: id, status: 'uploaded', progress: 100, uploadedAt: Date.now() });
const descriptor = id => ({ id, objectPrefix: `private-videos/${id}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest, createdAt: Date.now() });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for synthetic queue');
}
function syntheticPackage(directory) {
  const key = randomBytes(16);
  return { key, directory, duration: 6, manifest, segments: [{ name: 'segment-00000.ts', file: path.join(directory, 'segment-00000.ts'), bytes: 32 }], cleanup: async () => { key.fill(0); } };
}
const defaultSeams = { findAsset: () => null, saveAsset: asset => asset, wrapKey: () => 'wrapped-only', verifyPrivate: async () => {} };
const savedAssetSeams = { findAsset: id => ({ ...descriptor(id), wrappedKey: 'wrapped-only' }), unwrapKey: () => Buffer.alloc(16) };

test('permanent legacy MP4 policy remains strict; existing public uploads stay unchanged when rollout is off', async t => {
  await fixture(t);
  const base = urls.ossArticleVideoBaseUrl();
  assert.equal(urls.isOssArticleVideoSource(`${base}/${ID}/video.mp4`), true);
  for (const value of [`${base}/${ID}/video.mp4?token=x`, `${base}/${ID}/video.mp4#x`, `${base}/${ID}/../video.mp4`, `${base}/${ID}%2Fvideo.mp4`, 'http://127.0.0.1/video.mp4', 'blob:https://example.com/id', 'https://other.example/video.mp4']) assert.equal(urls.isOssArticleVideoSource(value), false);
  const job = getVideoJob(ID); job.publication = publicResult(ID);
  delete process.env.PRIVATE_VIDEO_UPLOAD_ENABLED;
  assert.equal(oss.enqueueVideoOssUpload(ID, true), job);
  assert.equal(await oss.uploadVideoFileToOss(job, { createClient: () => assert.fail('legacy is never reuploaded') }), job.publication);
  assert.equal(oss.videoOssStatus().ready, false);
  assert.match(oss.videoOssStatus().message, /PRIVATE_VIDEO_UPLOAD_ENABLED/);
});

test('new upload sends encrypted segments only, with private ACL, verifies before registering, and clears plaintext key', async t => {
  const directory = await fixture(t), packaged = syntheticPackage(directory), calls = [], progress = [];
  await writeFile(packaged.segments[0].file, Buffer.alloc(32, 63));
  process.env.OSS_CNAME = 'true'; process.env.OSS_ENDPOINT = 'https://untrusted.example'; process.env.OSS_PUBLIC_BASE_URL = 'https://public-cdn.example';
  const result = await oss.uploadVideoFileToOss(getVideoJob(ID), {
    ...defaultSeams, packageVideo: async file => { assert.equal(file, path.join(directory, ID, 'video.mp4')); return packaged; },
    progress: value => progress.push(value),
    createClient: config => {
      assert.equal(config.cname, false); assert.equal(config.endpoint, 'https://oss-cn-hangzhou.aliyuncs.com'); assert.equal(config.authorizationV4, true);
      return { put: async (name, file, options) => {
        calls.push('put'); assert.equal(name, `private-videos/${ID}/segment-00000.ts`); assert.equal(file, packaged.segments[0].file);
        assert.equal(options.headers['x-oss-object-acl'], 'private'); assert.equal(options.headers['Cache-Control'], 'private, no-store'); assert.equal(options.mime, 'video/mp2t');
      }, cancel() { assert.fail('successful upload does not cancel'); } };
    },
    verifyPrivate: async asset => { assert.equal(asset.manifest, manifest); assert.ok(!('wrappedKey' in asset)); calls.push('verify'); },
    wrapKey: (id, key) => { assert.equal(id, ID); assert.equal(key.length, 16); calls.push('wrap'); return 'wrapped-only'; },
    saveAsset: asset => { assert.equal(asset.wrappedKey, 'wrapped-only'); calls.push('save'); return asset; },
  });
  assert.deepEqual(calls, ['put', 'verify', 'wrap', 'save']); assert.deepEqual(progress, [1, 95]);
  assert.equal(result.kind, 'private'); assert.equal(result.assetId, ID); assert.equal(result.url, undefined); assert.equal(result.status, 'uploaded');
  assert.ok(packaged.key.every(byte => byte === 0)); assert.equal((await readFile(path.join(directory, ID, 'video.mp4'))).length, 24);
});

test('existing private uploads fail closed on missing metadata or wrong master key without overwriting ciphertext', async t => {
  await fixture(t); const job = getVideoJob(ID); job.publication = privateResult(ID);
  const blockedClient = () => assert.fail('existing private ID must never overwrite its objects');
  await assert.rejects(oss.uploadVideoFileToOss(job, { ...defaultSeams, createClient: blockedClient }), /恢复原数据库/);
  assert.throws(() => oss.enqueueVideoOssUpload(ID, true, async () => assert.fail('do not enqueue'), { findAsset: () => null }), /重新导入/);
  await assert.rejects(oss.uploadVideoFileToOss(job, { ...savedAssetSeams, createClient: blockedClient, unwrapKey: () => { throw new Error('bad master'); } }), /密钥无法解密/);
  const key = randomBytes(16);
  assert.equal(await oss.uploadVideoFileToOss(job, { ...savedAssetSeams, createClient: blockedClient, unwrapKey: () => key }), job.publication);
  assert.ok(key.every(byte => byte === 0));
  job.publication = { kind: 'private', assetId: ID, status: 'failed', progress: 95 };
  let verified = false;
  const recovered = await oss.uploadVideoFileToOss(job, { ...savedAssetSeams, createClient: blockedClient, verifyPrivate: async () => { verified = true; } });
  assert.equal(recovered.status, 'uploaded'); assert.equal(verified, true);
  await assert.rejects(oss.uploadVideoFileToOss(job, { ...savedAssetSeams, createClient: blockedClient, unwrapKey: () => { throw new Error('bad master'); }, verifyPrivate: async () => assert.fail('bad key cannot recover') }), /密钥无法解密/);
});

test('privacy-check failure never registers, SDK errors are redacted, timeout cleans key, original remains', async t => {
  const directory = await fixture(t);
  for (const mode of ['acl', 'sdk', 'timeout']) {
    const packaged = syntheticPackage(directory); let release, canceled = 0;
    await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), {
      ...defaultSeams, packageVideo: async () => packaged, saveAsset: () => assert.fail('failed upload must not register'), timeoutMs: mode === 'timeout' ? 10 : 1000,
      createClient: () => ({ put: async () => {
        if (mode === 'sdk') throw Object.assign(new Error('SECRET-signed-url'), { code: 'AccessDenied' });
        if (mode === 'timeout') await new Promise((resolve, reject) => { release = reject; });
      }, cancel() { canceled++; release?.(new Error('cancelled')); } }),
      verifyPrivate: async () => { throw new Error('SECRET-privacy-check'); },
    }), error => !/SECRET/.test(error.message) && (mode !== 'timeout' || /30 分钟/.test(error.message)));
    assert.ok(canceled > 0); assert.ok(packaged.key.every(byte => byte === 0));
  }
  assert.equal((await readFile(path.join(directory, ID, 'video.mp4'))).length, 24);
});

test('file checks reject symlinks, missing or changed MP4 before packaging or creating OSS clients', async t => {
  const directory = await fixture(t), file = path.join(directory, ID, 'video.mp4');
  const options = { ...defaultSeams, createClient: () => assert.fail('invalid file'), packageVideo: async () => assert.fail('invalid file') };
  await writeFile(file, Buffer.alloc(25)); await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), options), /文件已改变/);
  await rm(file); await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), options), /本地完整视频/);
  const target = path.join(directory, 'other.mp4'); await writeFile(target, Buffer.alloc(24)); await symlink(target, file);
  await assert.rejects(oss.uploadVideoFileToOss(getVideoJob(ID), options), /本地完整视频/);
});

test('OSS verification rejects public objects and foreign namespace, signs only canonical segments', async t => {
  await fixture(t); const asset = descriptor(ID); let heads = 0, cancels = 0;
  const createClient = () => ({ head: async key => { heads++; assert.equal(key, `${asset.objectPrefix}/segment-00000.ts`); return { status: 200, res: { headers: { 'content-length': '32' } } }; }, cancel() { cancels++; }, signatureUrlV4: async (method, expiry, query, key) => { assert.equal(method, 'GET'); assert.equal(expiry, 60); assert.equal(key, `${asset.objectPrefix}/segment-00000.ts`); return 'https://fixture.invalid/signed'; } });
  const deny = async (url, options) => { assert.equal(url, `https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/${asset.objectPrefix}/segment-00000.ts`); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return new Response(null, { status: 403 }); };
  await storage.verifyPrivateVideoAsset(asset, { createClient, fetch: deny }); assert.equal(heads, 1);
  assert.equal(await storage.signPrivateVideoSegment(asset, 0, { createClient }), 'https://fixture.invalid/signed');
  await assert.rejects(storage.signPrivateVideoSegment(asset, 1, { createClient }), /分片不存在/);
  await assert.rejects(storage.verifyPrivateVideoAsset({ ...asset, bucket: 'foreign-bucket' }, { createClient, fetch: deny }), /不一致/);
  await assert.rejects(storage.verifyPrivateVideoAsset({ ...asset, objectPrefix: `article-videos/${ID}` }, { createClient, fetch: deny }), /不一致/);
  for (const status of [200, 206, 404, 500]) await assert.rejects(storage.verifyPrivateVideoAsset(asset, { createClient, fetch: async () => new Response(null, { status }) }), /匿名访问/);
  assert.ok(cancels >= 4);
  process.env.PRIVATE_VIDEO_OSS_PREFIX = 'article-images/private'; assert.equal(storage.privateVideoOssStatus().ready, false);
  process.env.PRIVATE_VIDEO_OSS_PREFIX = '../private'; assert.equal(storage.privateVideoOssStatus().ready, false);
});

test('OSS privacy verification is bounded to four concurrent reads and aborts within total deadline', async t => {
  await fixture(t); const asset = descriptor(ID);
  asset.manifest = manifest.replace('#EXT-X-ENDLIST\n', Array.from({ length: 7 }, (_, index) => `#EXTINF:6.000000,\nsegment-${String(index + 1).padStart(5, '0')}.ts\n`).join('') + '#EXT-X-ENDLIST\n');
  let active = 0, maximum = 0;
  const createClient = () => ({ head: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { status: 200, res: { headers: { 'content-length': '32' } } }; }, cancel() {}, signatureUrlV4() {} });
  await storage.verifyPrivateVideoAsset(asset, { createClient, fetch: async () => new Response(null, { status: 403 }) });
  assert.equal(maximum, 4);
  await assert.rejects(storage.verifyPrivateVideoAsset(asset, { timeoutMs: 5, createClient, fetch: async () => new Response(null, { status: 403 }) }), /超时/);
  // The OSS SDK's cancel() does not interrupt HEAD; the verification deadline still must return.
  await assert.rejects(storage.verifyPrivateVideoAsset(asset, { timeoutMs: 5,
    createClient: () => ({ head: () => new Promise(() => {}), cancel() {}, signatureUrlV4() {} }),
    fetch: async () => assert.fail('hung HEAD never fetches anonymous object'),
  }), /超时/);
});

test('single upload queue deduplicates and retries, preserves safe metadata, and keeps a 12-job bound', async t => {
  const directory = await fixture(t, [{ id: ID }, { id: SECOND }]);
  let active = 0, maximum = 0, calls = 0;
  const upload = async (job, { progress }) => { active++; maximum = Math.max(maximum, active); calls++; progress(25); await new Promise(resolve => setTimeout(resolve, 15)); active--; if (job.id === SECOND && calls === 2) throw new Error('SECRET'); return privateResult(job.id); };
  assert.throws(() => oss.enqueueVideoOssUpload(ID, false, upload), /确认/);
  const first = oss.enqueueVideoOssUpload(ID, true, upload); assert.equal(oss.enqueueVideoOssUpload(ID, true, upload), first);
  oss.enqueueVideoOssUpload(SECOND, true, upload); await until(() => getVideoJob(SECOND).publication.status === 'failed');
  assert.equal(maximum, 1); assert.equal(calls, 2); assert.ok(!getVideoJob(SECOND).publication.error.includes('SECRET'));
  oss.enqueueVideoOssUpload(ID, true, upload, savedAssetSeams); assert.equal(calls, 2);
  oss.enqueueVideoOssUpload(SECOND, true, upload); await until(() => getVideoJob(SECOND).publication.status === 'uploaded');
  for (const id of [ID, SECOND]) { const saved = JSON.parse(await readFile(path.join(directory, id, 'result.json'), 'utf8')); assert.equal(saved.publication.kind, 'private'); assert.equal(saved.publication.assetId, id); assert.ok(!/SECRET|wrappedKey|fixture-secret/.test(JSON.stringify(saved))); }
});

test('configuration rollout, queue bound and interrupted publication recovery are explicit', async t => {
  const jobs = Array.from({ length: 13 }, (_, index) => ({ id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` }));
  jobs[0].publication = { kind: 'private', assetId: jobs[0].id, status: 'uploading', progress: 75 };
  await fixture(t, jobs); const restored = listVideoJobs();
  assert.equal(getVideoJob(jobs[0].id).publication.kind, 'private'); assert.equal(getVideoJob(jobs[0].id).publication.status, 'failed');
  delete process.env.PRIVATE_VIDEO_MASTER_KEY; assert.equal(oss.videoOssStatus().ready, false); assert.match(oss.videoOssStatus().message, /PRIVATE_VIDEO_MASTER_KEY/);
  process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
  let release; const hold = new Promise(resolve => { release = resolve; }); const upload = async job => { await hold; return privateResult(job.id); };
  for (const job of restored.slice(0, 12)) oss.enqueueVideoOssUpload(job.id, true, upload);
  assert.throws(() => oss.enqueueVideoOssUpload(restored[12].id, true, upload), /队列已满/);
  release(); await until(() => restored.slice(0, 12).every(job => job.publication.status === 'uploaded'));
});
