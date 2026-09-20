import { verifyAdminRequest } from "./admin-auth";
import { assertPrivateVideoSameOrigin, privateVideoSecureTransport, requirePrivateVideoAccess } from "./private-video-access";
import { getPrivateVideoAsset, PrivateVideoError, unwrapVideoKey, validatePrivateVideoManifest } from "./private-videos";
import { signPrivateVideoSegment } from "./oss-private-videos";

export function privateVideoHeaders(contentType = "application/json") {
  return new Headers({ "Content-Type": contentType, "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "Vary": "Cookie" });
}
export function privateVideoJSON(value: unknown, status = 200, cookie?: string | string[]) {
  const headers = privateVideoHeaders();
  for (const value of Array.isArray(cookie) ? cookie : cookie ? [cookie] : []) headers.append("Set-Cookie", value);
  return new Response(JSON.stringify(value), { status, headers });
}
export function privateVideoFailure(error: unknown) {
  return privateVideoJSON({ error: error instanceof PrivateVideoError ? error.message : "私密视频服务暂时不可用，请稍后重试。" }, error instanceof PrivateVideoError ? error.status : 503);
}
export async function privateVideoBody(request: Request, limit = 4096): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) throw new PrivateVideoError("请求必须使用 JSON。", 415);
  if (Number(request.headers.get("content-length")) > limit) throw new PrivateVideoError("请求内容过大。", 413);
  const reader = request.body?.getReader(); if (!reader) throw new PrivateVideoError("请求内容为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length;
      if (size > limit) { await reader.cancel(); throw new PrivateVideoError("请求内容过大。", 413); }
      chunks.push(result.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof PrivateVideoError) throw error; throw new PrivateVideoError("JSON 请求格式无效。"); }
  finally { reader.releaseLock(); }
}
export async function requirePrivateVideoAdmin(request: Request, mutation = false) {
  if (!privateVideoSecureTransport(request)) throw new PrivateVideoError("私密视频管理和播放必须使用 HTTPS（本机开发除外）。", 403);
  if (!await verifyAdminRequest(request)) throw new PrivateVideoError("请先登录超级管理员。", 401);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new PrivateVideoError("请从本站管理页面操作。", 403);
  if (mutation) assertPrivateVideoSameOrigin(request);
}
export async function privateVideoPlayback(request: Request, id: string, resource: "manifest" | "key" | "segment", index?: string, admin = false) {
  try {
    if (admin) await requirePrivateVideoAdmin(request); else requirePrivateVideoAccess(request, id);
    const asset = getPrivateVideoAsset(id); if (!asset) throw new PrivateVideoError("视频不存在或尚未上传完成。", 404);
    const parsed = validatePrivateVideoManifest(asset.manifest);
    const base = `${admin ? "/api/admin/private-videos" : "/api/private-videos"}/${id}`;
    if (resource === "manifest") {
      let playlist = parsed.manifest.replace('URI="key.bin"', `URI="${base}/key"`);
      playlist = playlist.replace(/^segment-(\d{5})\.ts$/gm, (_, value: string) => `${base}/segments/${Number(value)}`);
      return new Response(playlist, { headers: privateVideoHeaders("application/vnd.apple.mpegurl") });
    }
    if (resource === "key") {
      const key = unwrapVideoKey(asset);
      try { return new Response(new Uint8Array(key), { headers: privateVideoHeaders("application/octet-stream") }); }
      finally { key.fill(0); }
    }
    if (!index || !/^(?:0|[1-9]\d{0,4})$/.test(index) || Number(index) >= parsed.segments.length) throw new PrivateVideoError("视频分片不存在。", 404);
    const location = await signPrivateVideoSegment(asset, Number(index));
    if (new URL(location).protocol !== "https:") throw new PrivateVideoError("视频存储地址不安全。", 503);
    const headers = privateVideoHeaders(); headers.set("Location", location);
    return new Response(null, { status: 307, headers });
  } catch (error) { return privateVideoFailure(error); }
}
