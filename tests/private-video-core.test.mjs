import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { loadTs } from './helpers/load-typescript.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'private-video-core-'));
const names = ['LOCATION_DB_PATH', 'PRIVATE_VIDEO_MASTER_KEY', 'PRIVATE_VIDEO_SYNC_PRIVATE_KEY', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.LOCATION_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
process.env.ADMIN_PASSWORD = 'synthetic-admin-only';
process.env.ADMIN_SESSION_SECRET = 'synthetic-session-secret-no-production-value';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const core = loadTs('../lib/private-videos.ts', import.meta.url);
const access = loadTs('../lib/private-video-access.ts', import.meta.url);
const { getDb } = loadTs('../db/index.ts', import.meta.url);
after(async () => {
  getDb().close();
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(directory, { recursive: true, force: true });
});
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXTINF:2.000000,\nsegment-00001.ts\n#EXT-X-ENDLIST\n';
const request = (cookie = '', extra = {}) => new Request('https://fixture.example/api/private-videos/access', { headers: { host: 'fixture.example', origin: 'https://fixture.example', cookie, ...extra } });
const asset = (id = randomUUID()) => ({ id, objectPrefix: `private-videos/${id}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest: playlist, createdAt: Date.now() });
const resetRate = () => getDb().exec('DELETE FROM private_video_rate_limits');

test('GCM wrapping is randomized, bound to asset identity and authenticates ciphertext', () => {
  const id = randomUUID(), key = randomBytes(16), first = core.wrapVideoKey(id, key), second = core.wrapVideoKey(id, key);
  assert.notEqual(first, second);
  assert.deepEqual(core.unwrapVideoKey({ id, wrappedKey: first }), key);
  assert.ok(!first.includes(key.toString('base64')));
  assert.throws(() => core.unwrapVideoKey({ id: randomUUID(), wrappedKey: first }), /密钥不可用/);
  const parts = first.split('.'); parts[2] = Buffer.alloc(16, 0).toString('base64url');
  assert.throws(() => core.unwrapVideoKey({ id, wrappedKey: parts.join('.') }), /密钥不可用/);
  const master = process.env.PRIVATE_VIDEO_MASTER_KEY;
  process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
  assert.throws(() => core.unwrapVideoKey({ id, wrappedKey: first }), /密钥不可用/);
  process.env.PRIVATE_VIDEO_MASTER_KEY = 'invalid';
  assert.equal(core.privateVideoKeyStatus().ready, false);
  process.env.PRIVATE_VIDEO_MASTER_KEY = master;
});

test('bounded manifest parser accepts only encrypted sequential VOD without network references', () => {
  const parsed = core.validatePrivateVideoManifest(playlist);
  assert.equal(parsed.duration, 8); assert.equal(parsed.segments.length, 2);
  for (const invalid of [
    playlist.replace('key.bin', 'https://evil.invalid/key'), playlist.replace('key.bin', '../key.bin'),
    playlist.replace('METHOD=AES-128', 'METHOD=NONE'), playlist.replace('segment-00000.ts', 'https://evil.invalid/0.ts'),
    playlist.replace('segment-00001.ts', 'segment-00000.ts'), playlist.replace('#EXT-X-ENDLIST', '#EXT-X-DISCONTINUITY'),
    playlist.replace('#EXT-X-PLAYLIST-TYPE:VOD\n', ''), playlist.replace('6.000000,', '0.000000,'),
    playlist.replace('#EXTINF:2.000000,', '#EXT-X-KEY:METHOD=NONE\n#EXTINF:2.000000,'),
    playlist.replace('IV=0x0123456789abcdef0123456789abcdef', 'IV=0x12'),
    playlist.replace('#EXT-X-TARGETDURATION:6', '#EXT-X-TARGETDURATION:1'),
    `${playlist}${'x'.repeat(1024 * 1024)}`,
  ]) assert.throws(() => core.validatePrivateVideoManifest(invalid), core.PrivateVideoError);
});

test('resource registration is immutable and idempotent across randomized key wraps', () => {
  const metadata = asset(), key = randomBytes(16);
  const saved = core.savePrivateVideoAsset({ ...metadata, wrappedKey: core.wrapVideoKey(metadata.id, key) });
  assert.deepEqual(core.getPrivateVideoAsset(metadata.id), saved);
  assert.deepEqual(core.savePrivateVideoAsset({ ...metadata, wrappedKey: core.wrapVideoKey(metadata.id, key) }), saved);
  assert.throws(() => core.savePrivateVideoAsset({ ...metadata, objectPrefix: `other/${metadata.id}`, wrappedKey: saved.wrappedKey }), /已存在/);
  assert.throws(() => core.savePrivateVideoAsset({ ...metadata, wrappedKey: core.wrapVideoKey(metadata.id, randomBytes(16)) }), /已存在/);
  for (const change of [{ objectPrefix: '../private/' + metadata.id }, { bucket: 'fixture.invalid/path' }, { region: 'https://evil' }, { createdAt: Infinity }, { id: '../../x' }]) assert.throws(() => core.validatePrivateVideoAssetMetadata({ ...metadata, ...change }), core.PrivateVideoError);
  assert.equal(core.getPrivateVideoAsset('bad'), null);
});

test('RSA-OAEP envelope opens only on intended deployment and plaintext key is not a descriptor', () => {
  const key = randomBytes(16), recipient = core.privateVideoSyncPublicKey();
  assert.match(recipient.keyId, /^[0-9a-f]{64}$/);
  const envelope = core.sealPrivateVideoKey(recipient.publicKey, key);
  assert.notEqual(envelope, key.toString('base64')); assert.deepEqual(core.openPrivateVideoKey(envelope), key);
  const ownPrivate = process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY;
  const different = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY = Buffer.from(different.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  assert.throws(() => core.openPrivateVideoKey(envelope), /无法验证/);
  process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY = ownPrivate;
  assert.throws(() => core.openPrivateVideoKey(Buffer.alloc(256).toString('base64')), /无法验证/);
  assert.throws(() => core.sealPrivateVideoKey('not a public key', key), /公钥无效/);
});

test('codes and tokens persist only hashes, work across devices, expire sessions but not codes', () => {
  resetRate(); const created = access.createPrivateVideoAccessCode('Synthetic viewer');
  assert.match(created.code, /^[A-Za-z0-9_-]{32}$/);
  const first = access.exchangePrivateVideoCode(request(), created.code);
  const second = access.exchangePrivateVideoCode(request(), created.code);
  const independentCode = access.createPrivateVideoAccessCode('Independent viewer');
  const independent = access.exchangePrivateVideoCode(request(), independentCode.code);
  assert.notEqual(first, second);
  const firstRequest = request(`shenxiang_private_video=${first}`), secondRequest = request(`shenxiang_private_video=${second}`);
  assert.equal(access.privateVideoRequestAuthorized(firstRequest), true);
  assert.equal(access.privateVideoRequestAuthorized(secondRequest), true);
  assert.equal(access.privateVideoRequestAuthorized(firstRequest, Date.now() + 31 * 86400000), false);
  const rows = JSON.stringify({ codes: getDb().prepare('SELECT * FROM private_video_access_codes').all(), sessions: getDb().prepare('SELECT * FROM private_video_sessions').all() });
  assert.ok(!rows.includes(created.code)); assert.ok(!rows.includes(first)); assert.ok(!rows.includes(second));
  assert.equal(access.listPrivateVideoAccessCodes().find(code => code.id === created.accessCode.id).revokedAt, null);
  access.revokePrivateVideoAccessCode(created.accessCode.id);
  assert.equal(access.privateVideoRequestAuthorized(firstRequest), false);
  assert.equal(access.privateVideoRequestAuthorized(secondRequest), false);
  assert.equal(access.privateVideoRequestAuthorized(request(`shenxiang_private_video=${independent}`)), true);
  assert.throws(() => access.exchangePrivateVideoCode(request(), created.code), /无效或已撤销/);
});

test('CSRF checks, production Secure cookies and durable attempt limits fail closed', () => {
  resetRate();
  assert.equal(access.privateVideoSameOrigin(request()), true);
  assert.equal(access.privateVideoSameOrigin(request('', { origin: 'https://evil.invalid' })), false);
  assert.equal(access.privateVideoSameOrigin(request('', { 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(access.privateVideoSameOrigin(new Request('http://fixture.example', { headers: { host: 'fixture.example', origin: 'http://fixture.example' } })), false);
  assert.equal(access.privateVideoSecureTransport(new Request('http://fixture.example')), false);
  assert.equal(access.privateVideoSecureTransport(new Request('http://fixture.example', { headers: { 'x-forwarded-proto': 'https' } })), true);
  assert.match(access.privateVideoSessionCookie('x', request()), /; Secure/);
  assert.ok(!access.privateVideoSessionCookie('x', new Request('http://127.0.0.1:3217', { headers: { host: '127.0.0.1:3217' } })).includes('; Secure'));
  assert.match(access.privateVideoSessionCookie('', request(), true), /Max-Age=0/);
  for (let i = 0; i < 20; i++) assert.throws(() => access.exchangePrivateVideoCode(request(), 'wrong'), error => error.status === 401);
  assert.throws(() => access.exchangePrivateVideoCode(request(), 'wrong'), error => error.status === 429);
  assert.equal(getDb().prepare("SELECT attempts FROM private_video_rate_limits WHERE bucket = 'global'").get().attempts, 20);
});

test('public playback rejects admin cookies and revocation; authorized manifest/key never expose OSS paths', async t => {
  resetRate();
  const http = loadTs('../lib/private-video-http.ts', import.meta.url);
  const oss = loadTs('../lib/oss-private-videos.ts', import.meta.url);
  const admin = loadTs('../lib/admin-auth.ts', import.meta.url);
  const metadata = asset(), key = randomBytes(16);
  core.savePrivateVideoAsset({ ...metadata, wrappedKey: core.wrapVideoKey(metadata.id, key) });
  const denied = await http.privateVideoPlayback(request(), metadata.id, 'key');
  assert.equal(denied.status, 401);
  const adminCookie = `shenxiang_admin_session=${await admin.createAdminSession()}`;
  assert.equal((await http.privateVideoPlayback(request(adminCookie), metadata.id, 'manifest')).status, 401);
  const preview = await http.privateVideoPlayback(request(adminCookie), metadata.id, 'manifest', undefined, true);
  assert.equal(preview.status, 200); assert.match(await preview.text(), /\/api\/admin\/private-videos\//);
  const created = access.createPrivateVideoAccessCode('playback');
  const token = access.exchangePrivateVideoCode(request(), created.code);
  const authorized = request(`shenxiang_private_video=${token}`);
  const response = await http.privateVideoPlayback(authorized, metadata.id, 'manifest');
  const manifest = await response.text(); assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(manifest, new RegExp(`/api/private-videos/${metadata.id}/key`));
  assert.ok(!manifest.includes('fixture-bucket')); assert.ok(!manifest.includes(key.toString('base64')));
  const keyResponse = await http.privateVideoPlayback(authorized, metadata.id, 'key');
  assert.deepEqual(Buffer.from(await keyResponse.arrayBuffer()), key);
  t.mock.method(oss, 'signPrivateVideoSegment', async (_, index) => `https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/segment-${index}.ts?signature=synthetic`);
  const segment = await http.privateVideoPlayback(authorized, metadata.id, 'segment', '0');
  assert.equal(segment.status, 307); assert.match(segment.headers.get('location'), /^https:/);
  assert.equal((await http.privateVideoPlayback(authorized, metadata.id, 'segment', '2')).status, 404);
  assert.equal((await http.privateVideoPlayback(authorized, metadata.id, 'segment', '../x')).status, 404);
  access.revokePrivateVideoAccessCode(created.accessCode.id);
  for (const kind of ['manifest', 'key', 'segment']) assert.equal((await http.privateVideoPlayback(authorized, metadata.id, kind, '0')).status, 401);
});

test('access route bounds JSON and protects session exchange/logout with same-origin checks', async () => {
  resetRate(); const route = loadTs('../app/api/private-videos/access/route.ts', import.meta.url);
  const created = access.createPrivateVideoAccessCode('route');
  const post = new Request('https://fixture.example/api/private-videos/access', { method: 'POST', headers: { host: 'fixture.example', origin: 'https://fixture.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: created.code }) });
  const response = await route.POST(post);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authorized: true });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await route.GET(request(cookie))).json()).authorized, true);
  const badOrigin = await route.DELETE(request(cookie, { origin: 'https://evil.invalid' })); assert.equal(badOrigin.status, 403);
  assert.equal((await route.DELETE(request(cookie))).status, 200);
  assert.equal((await (await route.GET(request(cookie))).json()).authorized, false);
  const oversized = new Request('https://fixture.example/api/private-videos/access', { method: 'POST', headers: { host: 'fixture.example', origin: 'https://fixture.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(5000) }) });
  assert.equal((await route.POST(oversized)).status, 413);
});
