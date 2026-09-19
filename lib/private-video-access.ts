import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../db";
import { PrivateVideoError, PRIVATE_VIDEO_ID } from "./private-videos";

export const PRIVATE_VIDEO_SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = "shenxiang_private_video";
export type PrivateVideoAccessCode = { id: string; label: string; createdAt: number; revokedAt: number | null };
const hash = (kind: string, value: string) => createHash("sha256").update(`private-video-${kind}-v1:${value}`).digest("hex");

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

function localHttp(request: Request) {
  const url = new URL(request.url);
  const host = (request.headers.get("host") || url.host).toLowerCase();
  return url.protocol === "http:" && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export function privateVideoSecureTransport(request: Request) {
  // Production deployments must bind Next to loopback and overwrite this
  // header at the trusted TLS proxy, never accept an untrusted direct backend.
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || localHttp(request);
}
export function privateVideoSameOrigin(request: Request) {
  try {
    const origin = new URL(request.headers.get("origin") || "");
    const expected = request.headers.get("host") || new URL(request.url).host;
    return privateVideoSecureTransport(request) && origin.host === expected && (origin.protocol === "https:" || (origin.protocol === "http:" && localHttp(request))) && request.headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}
export function assertPrivateVideoSameOrigin(request: Request) {
  if (!privateVideoSameOrigin(request)) throw new PrivateVideoError("请从本站页面操作私密视频。", 403);
}
function cookieToken(request: Request) {
  const value = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function privateVideoSessionCookie(token: string, request: Request, clear = false) {
  return `${COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : PRIVATE_VIDEO_SESSION_SECONDS}${localHttp(request) ? "" : "; Secure"}`;
}
export function privateVideoRequestAuthorized(request: Request, now = Date.now()) {
  if (!privateVideoSecureTransport(request) || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const token = cookieToken(request); if (!token) return false;
  return Boolean(getDb().prepare("SELECT 1 FROM private_video_sessions s JOIN private_video_access_codes c ON c.id = s.code_id WHERE s.token_hash = ? AND s.expires_at > ? AND c.revoked_at IS NULL").get(hash("session", token), now));
}
export function requirePrivateVideoAccess(request: Request) {
  if (!privateVideoRequestAuthorized(request)) throw new PrivateVideoError("请输入有效的视频访问码。", 401);
}
export function revokePrivateVideoSession(request: Request) {
  const token = cookieToken(request);
  if (token) getDb().prepare("DELETE FROM private_video_sessions WHERE token_hash = ?").run(hash("session", token));
}

// Durable global + per-client caps: forwarded headers cannot bypass the global cap.
function recordAttempt(request: Request, now: number) {
  const db = getDb(); const client = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const buckets: [string, number][] = [["global", 500], [hash("rate", client.slice(0, 200)), 20]];
  db.prepare("DELETE FROM private_video_rate_limits WHERE resets_at <= ?").run(now);
  for (const [bucket, limit] of buckets) {
    const row = db.prepare("SELECT attempts FROM private_video_rate_limits WHERE bucket = ?").get(bucket);
    if (row && Number(row.attempts) >= limit) throw new PrivateVideoError("尝试次数过多，请 15 分钟后重试。", 429);
  }
  for (const [bucket] of buckets) db.prepare("INSERT INTO private_video_rate_limits (bucket, attempts, resets_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1").run(bucket, now + 15 * 60 * 1000);
}
export function exchangePrivateVideoCode(request: Request, candidate: unknown) {
  assertPrivateVideoSameOrigin(request);
  const db = getDb(); const now = Date.now(); let token: string | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    recordAttempt(request, now);
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
