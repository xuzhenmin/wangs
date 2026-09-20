import { createHash } from "node:crypto";
import { getDb } from "../db";
import { PrivateVideoError } from "./private-videos";

export function privateVideoLocalHttp(request: Request) {
  const url = new URL(request.url);
  const host = (request.headers.get("host") || url.host).toLowerCase();
  return request.headers.get("x-forwarded-proto") !== "https" && url.protocol === "http:" && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export function privateVideoSecureTransport(request: Request) {
  // Only trust this forwarded header behind the documented loopback TLS proxy.
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || privateVideoLocalHttp(request);
}
export function privateVideoSameOrigin(request: Request) {
  try {
    const origin = new URL(request.headers.get("origin") || "");
    const expected = request.headers.get("host") || new URL(request.url).host;
    return privateVideoSecureTransport(request) && origin.host === expected && (origin.protocol === "https:" || (origin.protocol === "http:" && privateVideoLocalHttp(request))) && request.headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}
export function assertPrivateVideoSameOrigin(request: Request) {
  if (!privateVideoSameOrigin(request)) throw new PrivateVideoError("请从本站页面操作私密视频。", 403);
}
export function privateVideoCookieToken(request: Request, name: string) {
  const value = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function privateVideoCookie(name: string, token: string, request: Request, maxAge: number) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${!name.startsWith("__Host-") && privateVideoLocalHttp(request) ? "" : "; Secure"}`;
}
export const privateVideoTokenHash = (kind: string, value: string) => createHash("sha256").update(`private-video-${kind}-v1:${value}`).digest("hex");

// Call inside a transaction. The caller commits failed attempts rather than
// rolling their counters back; successful share-link exchanges do not count.
export function recordPrivateVideoAttempt(request: Request, now: number) {
  const db = getDb(); const client = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const buckets: [string, number][] = [["global", 500], [privateVideoTokenHash("rate", client.slice(0, 200)), 20]];
  db.prepare("DELETE FROM private_video_rate_limits WHERE resets_at <= ?").run(now);
  for (const [bucket, limit] of buckets) {
    const row = db.prepare("SELECT attempts FROM private_video_rate_limits WHERE bucket = ?").get(bucket);
    if (row && Number(row.attempts) >= limit) throw new PrivateVideoError("尝试次数过多，请 15 分钟后重试。", 429);
  }
  for (const [bucket] of buckets) db.prepare("INSERT INTO private_video_rate_limits (bucket, attempts, resets_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1").run(bucket, now + 15 * 60 * 1000);
}
