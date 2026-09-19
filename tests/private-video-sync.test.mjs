import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { loadTs } from './helpers/load-typescript.mjs';

const core = loadTs('../lib/private-videos.ts', import.meta.url);
const storage = loadTs('../lib/oss-private-videos.ts', import.meta.url);
const sync = loadTs('../lib/private-video-sync.ts', import.meta.url);
const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });

test('private resource sync sends recipient-only key envelope, verifies before registration, preserves immutable identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-video-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.LOCATION_DB_PATH = path.join(directory, 'test.sqlite');
  process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
  const receiver = pair();
  process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY = Buffer.from(receiver.privateKey).toString('base64');
  const id = randomUUID(), key = randomBytes(16);
  const asset = { id, objectPrefix: `private-videos/${id}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest, createdAt: Date.now(), wrappedKey: core.wrapVideoKey(id, key) };
  core.savePrivateVideoAsset(asset);
  const caps = { protocol: sync.PRIVATE_VIDEO_SYNC_PROTOCOL, ...core.privateVideoSyncPublicKey() };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://receiver.example/api/article-sync/private-videos');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-sync-auth');
    requests.push(options);
    if (options.method === 'GET') return Response.json(caps);
    const body = JSON.parse(options.body);
    assert.ok(!options.body.includes(asset.wrappedKey));
    assert.ok(!options.body.includes(key.toString('base64')));
    assert.equal(body.recipientKeyId, caps.keyId);
    assert.deepEqual(core.openPrivateVideoKey(body.encryptedKey), key);
    return Response.json({ id, protocol: sync.PRIVATE_VIDEO_SYNC_PROTOCOL });
  });
  await sync.syncPrivateVideosBeforeArticle(`<video data-private-video-id="${id}"></video>`.repeat(2), new URL('https://receiver.example/api/article-sync'), 'synthetic-sync-auth');
  assert.equal(requests.length, 2, 'one capability check and one deduplicated asset upload');
  await assert.rejects(sync.syncPrivateVideosBeforeArticle(`<video data-private-video-id="${id}"></video>`, new URL('http://receiver.example/api/article-sync'), 'secret'), /HTTPS/);
  const oldCalls = requests.length;
  await sync.syncPrivateVideosBeforeArticle('<video src="https://legacy.example/video.mp4"></video>', new URL('http://receiver.example/api/article-sync'), 'secret');
  assert.equal(requests.length, oldCalls, 'legacy public video needs no private sync calls');

  const inboundId = randomUUID(), inboundKey = randomBytes(16);
  // Simulate an independent receiving deployment; old sender wraps must not open here.
  process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
  assert.throws(() => core.unwrapVideoKey(asset), /密钥不可用/);
  const input = { protocol: sync.PRIVATE_VIDEO_SYNC_PROTOCOL, recipientKeyId: caps.keyId,
    asset: { id: inboundId, objectPrefix: `private-videos/${inboundId}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest, createdAt: Date.now() },
    encryptedKey: core.sealPrivateVideoKey(caps.publicKey, inboundKey) };
  let checks = 0;
  t.mock.method(storage, 'verifyPrivateVideoAsset', async descriptor => {
    assert.equal(descriptor.id, inboundId); checks++;
    if (checks === 1) throw new Error('synthetic denied OSS read');
  });
  await assert.rejects(sync.receivePrivateVideoAsset(input), /denied OSS read/);
  assert.equal(core.getPrivateVideoAsset(inboundId), null, 'failed OSS verification never registers');
  assert.deepEqual(await sync.receivePrivateVideoAsset(input), { id: inboundId });
  const saved = core.getPrivateVideoAsset(inboundId);
  assert.deepEqual(core.unwrapVideoKey(saved), inboundKey);
  assert.deepEqual(await sync.receivePrivateVideoAsset(input), { id: inboundId }, 'idempotent retry');
  await assert.rejects(sync.receivePrivateVideoAsset({ ...input, asset: { ...input.asset, createdAt: input.asset.createdAt - 1 } }), /已存在/);
  await assert.rejects(sync.receivePrivateVideoAsset({ ...input, recipientKeyId: 'another-server' }), /密钥已变化/);
  await assert.rejects(sync.receivePrivateVideoAsset({ ...input, protocol: 'old' }), /协议/);
  await assert.rejects(sync.receivePrivateVideoAsset({ ...input, asset: { ...input.asset, manifest: manifest.replace('segment-00000.ts', 'https://private.example/secret') } }), /分片/);

  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  await assert.rejects(sync.syncPrivateVideosBeforeArticle(`<video data-private-video-id="${id}"></video>`, new URL('https://receiver.example/api/article-sync'), 'secret'), /更新远端代码/);
  const other = pair();
  process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY = Buffer.from(other.privateKey).toString('base64');
  assert.throws(() => core.openPrivateVideoKey(input.encryptedKey), /无法验证/);
});

test('resource description parser bounds streamed and declared bodies without trusting Content-Length', async () => {
  await assert.rejects(sync.boundedVideoSyncJSON(new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024) } })), /1 MiB/);
  await assert.rejects(sync.boundedVideoSyncJSON(new Response('x'.repeat(1024 * 1024 + 1))), /1 MiB/);
  await assert.rejects(sync.boundedVideoSyncJSON(new Response('not json')), /格式无效/);
  assert.deepEqual(await sync.boundedVideoSyncJSON(Response.json({ ok: true })), { ok: true });
});
