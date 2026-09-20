import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../db";
import { privateVideoIdsFromContent } from "./article-videos";
import { getPrivateVideoAsset, PrivateVideoError, PRIVATE_VIDEO_ID } from "./private-videos";
import { assertPrivateVideoSameOrigin, privateVideoCookie, privateVideoCookieToken, privateVideoLocalHttp, privateVideoSecureTransport, privateVideoTokenHash, recordPrivateVideoAttempt } from "./private-video-auth-utils";

export const ARTICLE_VIDEO_VIEWER_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "__Host-shenxiang_article_video";
const LOCAL_COOKIE = "shenxiang_article_video";
const ARTICLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{32}$/;
type ShareRow = { articleId: string; generation: string; codeHash: string; wrappedCode: string; createdAt: number; revokedAt: number | null };
export type ArticleVideoShare = { code: string | null; sharePath: string | null; createdAt: number; revokedAt: number | null };
type ArticleScope = { id: string; assetIds: string[] };

function masterKey() {
  const value = process.env.PRIVATE_VIDEO_MASTER_KEY || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new PrivateVideoError("请先配置 PRIVATE_VIDEO_MASTER_KEY 后再管理文章视频分享链接。", 503);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) { key.fill(0); throw new PrivateVideoError("PRIVATE_VIDEO_MASTER_KEY 格式无效。", 503); }
  return key;
}
function wrapShareCode(articleId: string, generation: string, code: string) {
  const master = masterKey();
  try {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(Buffer.from(`article-video-share-v1:${articleId}:${generation}`));
    const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  } finally { master.fill(0); }
}
function unwrapShareCode(row: ShareRow) {
  const master = masterKey(); let plaintext: Buffer | undefined;
  try {
    const parts = row.wrappedCode.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || !parts.slice(1).every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
    const [iv, ciphertext, tag] = parts.slice(1).map(value => Buffer.from(value, "base64url"));
    if (iv.length !== 12 || ciphertext.length !== 32 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", master, iv);
    decipher.setAAD(Buffer.from(`article-video-share-v1:${row.articleId}:${row.generation}`)); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const code = plaintext.toString("utf8");
    if (!CODE.test(code) || privateVideoTokenHash("article-share-code", code) !== row.codeHash) throw new Error();
    return code;
  } catch { throw new PrivateVideoError("文章视频分享链接暂时无法读取，请核对本机密钥或备份。", 503); }
  finally { master.fill(0); plaintext?.fill(0); }
}
function articleScope(articleId: string): ArticleScope | null {
  if (!ARTICLE_ID.test(articleId)) return null;
  const article = getDb().prepare("SELECT id, content FROM articles WHERE id = ? AND status = 'published'").get(articleId);
  if (!article || typeof article.content !== "string") return null;
  const ids = privateVideoIdsFromContent(article.content);
  if (!ids.length || ids.some(id => !getPrivateVideoAsset(id))) return null;
  return { id: String(article.id), assetIds: ids };
}
function requireArticleScope(articleId: string) {
  const scope = articleScope(articleId);
  if (!scope) throw new PrivateVideoError("仅支持为包含已就绪私密视频的已发布文章管理分享链接。", 422);
  return scope;
}
export function articleHasPrivateVideos(articleId: unknown) {
  return typeof articleId === "string" && articleScope(articleId) !== null;
}
function shareRow(articleId: string): ShareRow | null {
  const row = getDb().prepare("SELECT article_id AS articleId, generation, code_hash AS codeHash, wrapped_code AS wrappedCode, created_at AS createdAt, revoked_at AS revokedAt FROM article_video_shares WHERE article_id = ?").get(articleId);
  return row ? { ...row } as unknown as ShareRow : null;
}
function adminShare(row: ShareRow): ArticleVideoShare {
  if (row.revokedAt !== null) return { code: null, sharePath: null, createdAt: row.createdAt, revokedAt: row.revokedAt };
  const code = unwrapShareCode(row);
  return { code, sharePath: `/articles/${row.articleId}#video-access=${code}`, createdAt: row.createdAt, revokedAt: null };
}
export function getArticleVideoShare(articleId: string) {
  requireArticleScope(articleId);
  const row = shareRow(articleId);
  return { share: row ? adminShare(row) : null, hasPrivateVideos: true as const };
}
export function ensureArticleVideoShare(articleId: string, action: "ensure" | "rotate" = "ensure") {
  if (action !== "ensure" && action !== "rotate") throw new PrivateVideoError("文章视频分享操作无效。");
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    requireArticleScope(articleId);
    const existing = shareRow(articleId);
    if (existing && action === "ensure") { const result = { share: adminShare(existing), hasPrivateVideos: true as const }; db.exec("COMMIT"); return result; }
    const code = randomBytes(24).toString("base64url"), generation = randomUUID(), createdAt = Date.now();
    const codeHash = privateVideoTokenHash("article-share-code", code), wrappedCode = wrapShareCode(articleId, generation, code);
    db.prepare(`INSERT INTO article_video_shares (article_id, generation, code_hash, wrapped_code, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(article_id) DO UPDATE SET generation=excluded.generation, code_hash=excluded.code_hash, wrapped_code=excluded.wrapped_code, created_at=excluded.created_at, revoked_at=NULL`).run(articleId, generation, codeHash, wrappedCode, createdAt);
    db.prepare("DELETE FROM article_video_viewer_grants WHERE article_id = ?").run(articleId);
    db.exec("COMMIT");
    return { share: { code, sharePath: `/articles/${articleId}#video-access=${code}`, createdAt, revokedAt: null }, hasPrivateVideos: true as const };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function revokeArticleVideoShare(articleId: string) {
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    requireArticleScope(articleId);
    const changed = db.prepare("UPDATE article_video_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE article_id = ?").run(Date.now(), articleId);
    if (!changed.changes) throw new PrivateVideoError("此文章尚未创建视频分享链接。", 404);
    db.prepare("DELETE FROM article_video_viewer_grants WHERE article_id = ?").run(articleId);
    const row = shareRow(articleId); db.exec("COMMIT");
    return { share: row ? adminShare(row) : null, hasPrivateVideos: true as const };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
// Browser-enforced host-only prefix prevents a sibling subdomain from fixing
// a session before this browser adds another article grant. No legacy alias is
// accepted on HTTPS. Only plain localhost development uses an unprefixed name.
export function articleVideoViewerCookieName(request: Request) { return privateVideoLocalHttp(request) ? LOCAL_COOKIE : COOKIE; }
function viewerToken(request: Request) { return privateVideoCookieToken(request, articleVideoViewerCookieName(request)); }
function viewerHash(request: Request) { const token = viewerToken(request); return token ? privateVideoTokenHash("article-viewer", token) : null; }
export function articleVideoViewerCookie(token: string, request: Request, clear = false) {
  return privateVideoCookie(articleVideoViewerCookieName(request), clear ? "" : token, request, clear ? 0 : ARTICLE_VIDEO_VIEWER_SECONDS);
}
function eligibleRequest(request: Request) { return privateVideoSecureTransport(request) && request.headers.get("sec-fetch-site") !== "cross-site"; }

export function requestAuthorizedForArticle(request: Request, articleId: string, now = Date.now()) {
  if (!eligibleRequest(request) || !articleScope(articleId)) return false;
  const sessionHash = viewerHash(request); if (!sessionHash) return false;
  return Boolean(getDb().prepare(`SELECT 1 FROM article_video_viewer_grants g
    JOIN article_video_viewer_sessions v ON v.token_hash = g.session_hash
    JOIN article_video_shares s ON s.article_id = g.article_id AND s.generation = g.generation
    WHERE g.session_hash = ? AND g.article_id = ? AND g.expires_at > ? AND v.expires_at > ? AND s.revoked_at IS NULL`).get(sessionHash, articleId, now, now));
}
export function requestAuthorizedForArticleVideo(request: Request, assetId: string, now = Date.now()) {
  if (!eligibleRequest(request) || !PRIVATE_VIDEO_ID.test(assetId) || !getPrivateVideoAsset(assetId)) return false;
  const sessionHash = viewerHash(request); if (!sessionHash) return false;
  const rows = getDb().prepare(`SELECT a.id, a.content FROM article_video_viewer_grants g
    JOIN article_video_viewer_sessions v ON v.token_hash = g.session_hash
    JOIN article_video_shares s ON s.article_id = g.article_id AND s.generation = g.generation
    JOIN articles a ON a.id = g.article_id AND a.status = 'published'
    WHERE g.session_hash = ? AND g.expires_at > ? AND v.expires_at > ? AND s.revoked_at IS NULL
      AND instr(a.content, ?) > 0`).all(sessionHash, now, now, assetId);
  return rows.some(row => typeof row.content === "string" && privateVideoIdsFromContent(row.content).includes(assetId));
}

/** Exchange only affects private-video grants; article UV and location gates remain separate. */
export function exchangeArticleVideoShare(request: Request, articleId: string, candidate: unknown) {
  assertPrivateVideoSameOrigin(request);
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  const db = getDb(), now = Date.now(); let token: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const scope = articleScope(articleId);
    const share = scope && CODE.test(normalized) ? db.prepare("SELECT generation FROM article_video_shares WHERE article_id = ? AND code_hash = ? AND revoked_at IS NULL").get(articleId, privateVideoTokenHash("article-share-code", normalized)) : undefined;
    if (!share) {
      recordPrivateVideoAttempt(request, now);
    } else {
      const old = viewerToken(request), oldHash = old ? privateVideoTokenHash("article-viewer", old) : null;
      const existing = oldHash ? db.prepare("SELECT token_hash FROM article_video_viewer_sessions WHERE token_hash = ? AND expires_at > ?").get(oldHash, now) : null;
      token = existing && old ? old : randomBytes(32).toString("base64url");
      const tokenHash = privateVideoTokenHash("article-viewer", token), expiresAt = now + ARTICLE_VIDEO_VIEWER_SECONDS * 1000;
      db.prepare("DELETE FROM article_video_viewer_grants WHERE expires_at <= ? OR session_hash IN (SELECT token_hash FROM article_video_viewer_sessions WHERE expires_at <= ?)").run(now, now);
      db.prepare("DELETE FROM article_video_viewer_sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO article_video_viewer_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at").run(tokenHash, now, expiresAt);
      // Only an explicit, valid link exchange starts another 30-day grant; merely
      // viewing a page or another article cannot extend an older grant.
      db.prepare(`INSERT INTO article_video_viewer_grants (session_hash, article_id, generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_hash, article_id) DO UPDATE SET generation=excluded.generation, created_at=excluded.created_at, expires_at=excluded.expires_at`).run(tokenHash, articleId, String(share.generation), now, expiresAt);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  if (!token) throw new PrivateVideoError("文章视频访问码无效、已撤销或内容暂不可用。", 401);
  return token;
}
export function revokeArticleVideoViewerGrant(request: Request, articleId: string) {
  const sessionHash = viewerHash(request); if (!sessionHash) return;
  getDb().prepare("DELETE FROM article_video_viewer_grants WHERE session_hash = ? AND article_id = ?").run(sessionHash, articleId);
}
export function revokeArticleVideoViewerSession(request: Request) {
  const sessionHash = viewerHash(request); if (!sessionHash) return;
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM article_video_viewer_grants WHERE session_hash = ?").run(sessionHash);
    db.prepare("DELETE FROM article_video_viewer_sessions WHERE token_hash = ?").run(sessionHash);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
