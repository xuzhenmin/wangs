import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../db";
import { PrivateVideoError, PRIVATE_VIDEO_ID } from "./private-videos";
import { requestAuthorizedForArticleVideo } from "./article-video-share";
import { assertPrivateVideoSameOrigin, privateVideoSecureTransport, privateVideoCookie, privateVideoCookieToken, privateVideoTokenHash as hash, recordPrivateVideoAttempt } from "./private-video-auth-utils";
export { assertPrivateVideoSameOrigin, privateVideoSecureTransport, privateVideoSameOrigin } from "./private-video-auth-utils";

export const PRIVATE_VIDEO_SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "shenxiang_private_video";
export type PrivateVideoAccessCode = { id: string; label: string; createdAt: number; revokedAt: number | null };

export function listPrivateVideoAccessCodes(): PrivateVideoAccessCode[] {
  return getDb().prepare("SELECT id, label, created_at AS createdAt, revoked_at AS revokedAt FROM private_video_access_codes ORDER BY created_at DESC LIMIT 1000").all() as unknown as PrivateVideoAccessCode[];
}
export function createPrivateVideoAccessCode(label: unknown = "") {
  if (typeof label !== "string" || label.trim().length > 100 || /[\x00-\x1f\x7f]/.test(label)) throw new PrivateVideoError("备注最多 100 个字符，不能包含控制字符。");
  const code = randomBytes(24).toString("base64url");
  const accessCode: PrivateVideoAccessCode = { id: randomUUID(), label: label.trim(), createdAt: Date.now(), revokedAt: null };
  getDb().prepare("INSERT INTO private_video_access_codes (id, code_hash, label, created_at) VALUES (?, ?, ?, ?)").run(accessCode.id, hash("code", code), accessCode.label, accessCode.createdAt);
  return { code, accessCode };
}
export function revokePrivateVideoAccessCode(id: string) {
  if (!PRIVATE_VIDEO_ID.test(id)) throw new PrivateVideoError("访问码不存在。", 404);
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("UPDATE private_video_access_codes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(Date.now(), id);
    if (!result.changes) throw new PrivateVideoError("访问码不存在。", 404);
    db.prepare("DELETE FROM private_video_sessions WHERE code_id = ?").run(id); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function cookieToken(request: Request) {
  return privateVideoCookieToken(request, COOKIE);
}
export function privateVideoSessionCookie(token: string, request: Request, clear = false) {
  return privateVideoCookie(COOKIE, clear ? "" : token, request, clear ? 0 : PRIVATE_VIDEO_SESSION_SECONDS);
}
export function privateVideoRequestAuthorized(request: Request, now = Date.now()) {
  if (!privateVideoSecureTransport(request) || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const token = cookieToken(request); if (!token) return false;
  return Boolean(getDb().prepare("SELECT 1 FROM private_video_sessions s JOIN private_video_access_codes c ON c.id = s.code_id WHERE s.token_hash = ? AND s.expires_at > ? AND c.revoked_at IS NULL").get(hash("session", token), now));
}
export function privateVideoRequestAuthorizedForAsset(request: Request, assetId: string, now = Date.now()) {
  if (!PRIVATE_VIDEO_ID.test(assetId)) return false;
  return privateVideoRequestAuthorized(request, now) || requestAuthorizedForArticleVideo(request, assetId, now);
}
export function requirePrivateVideoAccess(request: Request, assetId?: string) {
  const authorized = assetId === undefined ? privateVideoRequestAuthorized(request) : privateVideoRequestAuthorizedForAsset(request, assetId);
  if (!authorized) throw new PrivateVideoError("请输入有效的视频访问码或使用有效的文章分享链接。", 401);
}
export function revokePrivateVideoSession(request: Request) {
  const token = cookieToken(request);
  if (token) getDb().prepare("DELETE FROM private_video_sessions WHERE token_hash = ?").run(hash("session", token));
}
export function matchesPrivateVideoAccessCode(candidate: unknown) {
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  return /^[A-Za-z0-9_-]{32}$/.test(normalized) && Boolean(getDb().prepare("SELECT 1 FROM private_video_access_codes WHERE code_hash = ? AND revoked_at IS NULL").get(hash("code", normalized)));
}

export function exchangePrivateVideoCode(request: Request, candidate: unknown) {
  assertPrivateVideoSameOrigin(request);
  const db = getDb(); const now = Date.now(); let token: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    recordPrivateVideoAttempt(request, now);
    const normalized = typeof candidate === "string" ? candidate.trim() : "";
    const match = /^[A-Za-z0-9_-]{32}$/.test(normalized) ? db.prepare("SELECT id FROM private_video_access_codes WHERE code_hash = ? AND revoked_at IS NULL").get(hash("code", normalized)) : undefined;
    if (match) {
      token = randomBytes(32).toString("base64url");
      const oldToken = cookieToken(request);
      if (oldToken) db.prepare("DELETE FROM private_video_sessions WHERE token_hash = ?").run(hash("session", oldToken));
      db.prepare("DELETE FROM private_video_sessions WHERE expires_at <= ?").run(now);
      db.prepare("INSERT INTO private_video_sessions (token_hash, code_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash("session", token), String(match.id), now, now + PRIVATE_VIDEO_SESSION_SECONDS * 1000);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  if (!token) throw new PrivateVideoError("访问码无效或已撤销。", 401);
  return token;
}
