import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadTs } from './helpers/load-typescript.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'article-video-share-'));
const names = ['LOCATION_DB_PATH', 'PRIVATE_VIDEO_MASTER_KEY', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.LOCATION_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
process.env.ADMIN_PASSWORD = 'synthetic-share-admin';
process.env.ADMIN_SESSION_SECRET = 'synthetic-share-admin-session-never-production';
const core = loadTs('../lib/private-videos.ts', import.meta.url);
const share = loadTs('../lib/article-video-share.ts', import.meta.url);
const access = loadTs('../lib/private-video-access.ts', import.meta.url);
const http = loadTs('../lib/private-video-http.ts', import.meta.url);
const admin = loadTs('../lib/admin-auth.ts', import.meta.url);
const adminRoute = loadTs('../app/api/admin/articles/[id]/video-share/route.ts', import.meta.url);
const articleRoute = loadTs('../app/api/articles/[id]/video-access/route.ts', import.meta.url);
const accessRoute = loadTs('../app/api/private-videos/access/route.ts', import.meta.url);
const { getDb } = loadTs('../db/index.ts', import.meta.url);
after(async () => {
  getDb().close();
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(directory, { recursive: true, force: true });
});
const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789abcdef0123456789abcdef\n#EXTINF:6.000000,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
const videoHTML = id => `<video data-private-video-id="${id}" controls></video>`;
const context = id => ({ params: Promise.resolve({ id }) });
function request(cookie = '', options = {}) {
  const { url = 'https://fixture.example/api/private-videos/access', method = 'GET', body, headers = {} } = options;
  return new Request(url, { method, headers: { host: 'fixture.example', origin: 'https://fixture.example', cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const viewerCookie = token => `__Host-shenxiang_article_video=${token}`;
const resetRate = () => getDb().exec('DELETE FROM private_video_rate_limits');
function fixture(status = 'published', contentOverride) {
  const assetId = randomUUID(), articleId = randomUUID(), key = randomBytes(16);
  core.savePrivateVideoAsset({ id: assetId, objectPrefix: `private-videos/${assetId}`, bucket: 'fixture-bucket', region: 'oss-cn-hangzhou', manifest: playlist, wrappedKey: core.wrapVideoKey(assetId, key), createdAt: Date.now() });
  getDb().prepare('INSERT INTO articles (id,title,summary,content,status,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(articleId, 'Synthetic article', '', contentOverride ?? videoHTML(assetId), status, Date.now(), Date.now());
  return { articleId, assetId, key };
}
function grant(article) {
  const result = share.ensureArticleVideoShare(article.articleId);
  const token = share.exchangeArticleVideoShare(request(), article.articleId, result.share.code);
  return { ...result, token, request: request(viewerCookie(token)) };
}

test('admin read is non-mutating and lazy ensure stores only hash plus authenticated encrypted code', () => {
  const article = fixture();
  assert.deepEqual(share.getArticleVideoShare(article.articleId), { share: null, hasPrivateVideos: true });
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM article_video_shares WHERE article_id = ?').get(article.articleId).count, 0);
  const first = share.ensureArticleVideoShare(article.articleId), second = share.ensureArticleVideoShare(article.articleId);
  assert.deepEqual(second, first); assert.deepEqual(share.getArticleVideoShare(article.articleId), first);
  assert.match(first.share.code, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(first.share.sharePath, `/articles/${article.articleId}#video-access=${first.share.code}`);
  const stored = getDb().prepare('SELECT * FROM article_video_shares WHERE article_id = ?').get(article.articleId);
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/); assert.match(stored.wrapped_code, /^v1\./);
  assert.ok(!JSON.stringify(stored).includes(first.share.code));
});

test('share management rejects draft, absent, empty and unregistered private resources', () => {
  for (const article of [fixture('draft'), fixture('published', '<p>No video</p>'), fixture('published', videoHTML(randomUUID()))]) {
    assert.throws(() => share.ensureArticleVideoShare(article.articleId), error => error.status === 422);
    assert.throws(() => share.getArticleVideoShare(article.articleId), error => error.status === 422);
  }
  assert.throws(() => share.ensureArticleVideoShare(randomUUID()), error => error.status === 422);
  assert.throws(() => share.ensureArticleVideoShare('../../invalid'), error => error.status === 422);
  const article = fixture();
  assert.throws(() => share.revokeArticleVideoShare(article.articleId), error => error.status === 404);
});

test('missing or changed master key fails safely, and ciphertext cannot move across article identities', () => {
  const left = fixture(), right = fixture();
  share.ensureArticleVideoShare(left.articleId); share.ensureArticleVideoShare(right.articleId);
  const leftRow = getDb().prepare('SELECT wrapped_code FROM article_video_shares WHERE article_id = ?').get(left.articleId);
  const rightRow = getDb().prepare('SELECT wrapped_code FROM article_video_shares WHERE article_id = ?').get(right.articleId);
  getDb().prepare('UPDATE article_video_shares SET wrapped_code=? WHERE article_id=?').run(leftRow.wrapped_code, right.articleId);
  assert.throws(() => share.getArticleVideoShare(right.articleId), error => error.status === 503);
  getDb().prepare('UPDATE article_video_shares SET wrapped_code=? WHERE article_id=?').run(rightRow.wrapped_code, right.articleId);
  const original = process.env.PRIVATE_VIDEO_MASTER_KEY;
  process.env.PRIVATE_VIDEO_MASTER_KEY = randomBytes(32).toString('base64');
  assert.throws(() => share.getArticleVideoShare(left.articleId), error => error.status === 503);
  const unpublishedLink = fixture();
  delete process.env.PRIVATE_VIDEO_MASTER_KEY;
  assert.throws(() => share.ensureArticleVideoShare(unpublishedLink.articleId), error => error.status === 503);
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM article_video_shares WHERE article_id=?').get(unpublishedLink.articleId).count, 0);
  process.env.PRIVATE_VIDEO_MASTER_KEY = original;
  assert.ok(share.getArticleVideoShare(left.articleId).share.code);
});

test('one independent viewer cookie retains grants for multiple articles but not unrelated assets', () => {
  resetRate(); const left = fixture(), right = fixture(), unrelated = fixture();
  const first = grant(left), rightShare = share.ensureArticleVideoShare(right.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), true);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), false);
  assert.equal(access.privateVideoRequestAuthorized(first.request), false);
  const token = share.exchangeArticleVideoShare(first.request, right.articleId, rightShare.share.code);
  assert.equal(token, first.token);
  for (const article of [left, right]) {
    assert.equal(share.requestAuthorizedForArticle(first.request, article.articleId), true);
    assert.equal(access.privateVideoRequestAuthorizedForAsset(first.request, article.assetId), true);
  }
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, unrelated.assetId), false);
  const stored = JSON.stringify(getDb().prepare('SELECT * FROM article_video_viewer_sessions').all());
  assert.ok(!stored.includes(token));
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM consented_locations').get().count, 0);
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM article_view_events').get().count, 0);
});

test('asset membership, publication and existence are rechecked on each playback authorization', async () => {
  resetRate(); const article = fixture(), other = fixture(), granted = grant(article);
  const content = videoHTML(article.assetId);
  assert.equal((await http.privateVideoPlayback(granted.request, article.assetId, 'key')).status, 200);
  getDb().prepare('UPDATE articles SET content=? WHERE id=?').run(`<p>${article.assetId}</p>${videoHTML(other.assetId)}`, article.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(granted.request, article.assetId), false);
  assert.equal((await http.privateVideoPlayback(granted.request, article.assetId, 'manifest')).status, 401);
  getDb().prepare('UPDATE articles SET content=?, status=? WHERE id=?').run(content, 'draft', article.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(granted.request, article.assetId), false);
  assert.equal(share.requestAuthorizedForArticle(granted.request, article.articleId), false);
  getDb().prepare('UPDATE articles SET status=? WHERE id=?').run('published', article.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(granted.request, article.assetId), true);
  getDb().prepare('DELETE FROM articles WHERE id=?').run(article.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(granted.request, article.assetId), false);
});

test('rotation invalidates old links/grants, revoke stays revoked through ensure, other article stays authorized', () => {
  resetRate(); const left = fixture(), right = fixture(), first = grant(left), rightShare = share.ensureArticleVideoShare(right.articleId);
  share.exchangeArticleVideoShare(first.request, right.articleId, rightShare.share.code);
  const rotated = share.ensureArticleVideoShare(left.articleId, 'rotate');
  assert.notEqual(rotated.share.code, first.share.code);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), false);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), true);
  assert.throws(() => share.exchangeArticleVideoShare(first.request, left.articleId, first.share.code), error => error.status === 401);
  share.exchangeArticleVideoShare(first.request, left.articleId, rotated.share.code);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), true);
  const revoked = share.revokeArticleVideoShare(left.articleId);
  assert.equal(revoked.share.code, null); assert.equal(revoked.share.sharePath, null); assert.ok(revoked.share.revokedAt);
  assert.deepEqual(share.ensureArticleVideoShare(left.articleId), revoked);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), false);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), true);
  assert.throws(() => share.exchangeArticleVideoShare(first.request, left.articleId, rotated.share.code), error => error.status === 401);
});

test('grants and sessions expire after 30 days independently; ordinary authorization does not renew', () => {
  resetRate(); const left = fixture(), right = fixture(), first = grant(left), rightShare = share.ensureArticleVideoShare(right.articleId);
  share.exchangeArticleVideoShare(first.request, right.articleId, rightShare.share.code);
  const before = getDb().prepare('SELECT expires_at FROM article_video_viewer_grants WHERE article_id=?').get(left.articleId).expires_at;
  for (let index = 0; index < 5; index++) assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), true);
  assert.equal(getDb().prepare('SELECT expires_at FROM article_video_viewer_grants WHERE article_id=?').get(left.articleId).expires_at, before);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId, Date.now() + 31 * 86400000), false);
  getDb().prepare('UPDATE article_video_viewer_grants SET expires_at=1 WHERE article_id=?').run(left.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), false);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), true);
  getDb().prepare('UPDATE article_video_viewer_sessions SET expires_at=1 WHERE token_hash=(SELECT session_hash FROM article_video_viewer_grants WHERE article_id=?)').run(right.articleId);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), false);
});

test('valid popular share links do not consume failure budget, wrong article/code attempts are bounded', () => {
  resetRate(); const article = fixture(), other = fixture(), issued = share.ensureArticleVideoShare(article.articleId);
  for (let index = 0; index < 25; index++) share.exchangeArticleVideoShare(request(), article.articleId, issued.share.code);
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM private_video_rate_limits').get().count, 0);
  for (let index = 0; index < 20; index++) assert.throws(() => share.exchangeArticleVideoShare(request(), other.articleId, issued.share.code), error => error.status === 401);
  assert.throws(() => share.exchangeArticleVideoShare(request(), article.articleId, 'wrong'), error => error.status === 429);
  assert.match(share.exchangeArticleVideoShare(request(), article.articleId, issued.share.code), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(getDb().prepare("SELECT attempts FROM private_video_rate_limits WHERE bucket='global'").get().attempts, 20);
});

test('admin routes require authentication and CSRF; public status never exposes sharing credentials', async () => {
  resetRate(); const article = fixture();
  assert.equal((await adminRoute.GET(request(), context(article.articleId))).status, 401);
  const adminCookie = `shenxiang_admin_session=${await admin.createAdminSession()}`;
  assert.equal((await adminRoute.POST(request(adminCookie, { method: 'POST', headers: { origin: 'https://evil.invalid' }, body: { action: 'ensure' } }), context(article.articleId))).status, 403);
  const empty = await adminRoute.GET(request(adminCookie), context(article.articleId));
  assert.deepEqual(await empty.json(), { share: null, hasPrivateVideos: true });
  const created = await adminRoute.POST(request(adminCookie, { method: 'POST', body: { action: 'ensure' } }), context(article.articleId));
  assert.equal(created.status, 200); assert.match(created.headers.get('cache-control'), /no-store/);
  const result = await created.json(); assert.match(result.share.code, /^[A-Za-z0-9_-]{32}$/);
  const status = await articleRoute.GET(request(), context(article.articleId));
  assert.deepEqual(await status.json(), { authorized: false });
  const invalidAction = await adminRoute.POST(request(adminCookie, { method: 'POST', body: { action: 'reactivate' } }), context(article.articleId));
  assert.equal(invalidAction.status, 400);
});

test('public exchange is same-origin and bounded, sets independent Secure cookie and permits only article assets', async () => {
  resetRate(); const article = fixture(), other = fixture(), issued = share.ensureArticleVideoShare(article.articleId);
  const denied = await articleRoute.POST(request('', { method: 'POST', headers: { origin: 'https://evil.invalid' }, body: { code: issued.share.code } }), context(article.articleId));
  assert.equal(denied.status, 403);
  const oversized = await articleRoute.POST(request('', { method: 'POST', body: { code: 'x'.repeat(5000) } }), context(article.articleId));
  assert.equal(oversized.status, 413);
  const accepted = await articleRoute.POST(request('', { method: 'POST', body: { code: issued.share.code } }), context(article.articleId));
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { authorized: true });
  const cookie = accepted.headers.get('set-cookie'); assert.match(cookie, /^__Host-shenxiang_article_video=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /Max-Age=2592000/); assert.ok(!cookie.includes('Domain='));
  const authenticated = cookie.split(';')[0];
  assert.equal((await (await articleRoute.GET(request(authenticated), context(article.articleId))).json()).authorized, true);
  assert.equal((await (await accessRoute.GET(request(authenticated, { url: `https://fixture.example/api/private-videos/access?assetId=${article.assetId}` }))).json()).authorized, true);
  assert.equal((await (await accessRoute.GET(request(authenticated, { url: `https://fixture.example/api/private-videos/access?assetId=${other.assetId}` }))).json()).authorized, false);
  assert.equal((await (await accessRoute.GET(request(authenticated))).json()).authorized, false);
  assert.equal(share.requestAuthorizedForArticleVideo(request(authenticated, { headers: { 'sec-fetch-site': 'cross-site' } }), article.assetId), false);
});

test('manual form supports either old global code or article code, never widening article scope', async () => {
  resetRate(); const article = fixture(), other = fixture(), issued = share.ensureArticleVideoShare(article.articleId);
  const scoped = await accessRoute.POST(request('', { method: 'POST', body: { code: issued.share.code, articleId: article.articleId } }));
  assert.equal(scoped.status, 200); assert.match(scoped.headers.get('set-cookie'), /^__Host-shenxiang_article_video=/);
  assert.equal(getDb().prepare('SELECT count(*) AS count FROM private_video_rate_limits').get().count, 0);
  const scopedCookie = scoped.headers.get('set-cookie').split(';')[0];
  assert.equal(access.privateVideoRequestAuthorized(request(scopedCookie)), false);
  assert.equal(access.privateVideoRequestAuthorizedForAsset(request(scopedCookie), other.assetId), false);
  const global = access.createPrivateVideoAccessCode('Fixture global');
  const globalResponse = await accessRoute.POST(request('', { method: 'POST', body: { code: global.code, articleId: article.articleId } }));
  assert.equal(globalResponse.status, 200); assert.match(globalResponse.headers.get('set-cookie'), /shenxiang_private_video=/);
  const globalCookie = globalResponse.headers.get('set-cookie').split(';')[0];
  assert.equal(access.privateVideoRequestAuthorizedForAsset(request(globalCookie), other.assetId), true);
  const malformed = await accessRoute.GET(request(globalCookie, { url: 'https://fixture.example/api/private-videos/access?assetId=bad' }));
  assert.deepEqual(await malformed.json(), { authorized: false });
  const wrongArticle = await accessRoute.POST(request('', { method: 'POST', body: { code: global.code, articleId: 'bad' } }));
  assert.equal(wrongArticle.status, 422);
});

test('HTTPS ignores unprefixed fixation cookies; host-only production and localhost names stay separate', () => {
  resetRate(); const attackerArticle = fixture(), victimArticle = fixture();
  const attacker = grant(attackerArticle), victimShare = share.ensureArticleVideoShare(victimArticle.articleId);
  const injected = request(`shenxiang_article_video=${attacker.token}`);
  assert.equal(share.requestAuthorizedForArticleVideo(injected, attackerArticle.assetId), false);
  const victimToken = share.exchangeArticleVideoShare(injected, victimArticle.articleId, victimShare.share.code);
  assert.notEqual(victimToken, attacker.token);
  assert.equal(share.requestAuthorizedForArticleVideo(attacker.request, victimArticle.assetId), false);
  assert.equal(share.articleVideoViewerCookieName(request()), '__Host-shenxiang_article_video');
  const local = new Request('http://127.0.0.1:3217/api/private-videos/access', { headers: { host: '127.0.0.1:3217', origin: 'http://127.0.0.1:3217' } });
  assert.equal(share.articleVideoViewerCookieName(local), 'shenxiang_article_video');
  assert.ok(!share.articleVideoViewerCookie(victimToken, local).includes('; Secure'));
  const proxiedTLS = new Request('http://127.0.0.1:3217/api/private-videos/access', { headers: { host: 'fixture.example', origin: 'https://fixture.example', 'x-forwarded-proto': 'https' } });
  assert.equal(share.articleVideoViewerCookieName(proxiedTLS), '__Host-shenxiang_article_video');
  assert.match(share.articleVideoViewerCookie(victimToken, proxiedTLS), /; Secure/);
});

test('article-specific logout preserves other grants; common logout clears global and all scoped sessions', async () => {
  resetRate(); const left = fixture(), right = fixture(), first = grant(left), rightShare = share.ensureArticleVideoShare(right.articleId);
  share.exchangeArticleVideoShare(first.request, right.articleId, rightShare.share.code);
  const removed = await articleRoute.DELETE(first.request, context(left.articleId));
  assert.equal(removed.status, 200);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, left.assetId), false);
  assert.equal(share.requestAuthorizedForArticleVideo(first.request, right.assetId), true);
  const global = access.createPrivateVideoAccessCode('Fixture logout');
  const globalToken = access.exchangePrivateVideoCode(request(), global.code);
  const combined = request(`${viewerCookie(first.token)}; shenxiang_private_video=${globalToken}`);
  const logout = await accessRoute.DELETE(combined);
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.ok(logout.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
  assert.equal(access.privateVideoRequestAuthorized(combined), false);
  assert.equal(share.requestAuthorizedForArticleVideo(combined, right.assetId), false);
});
