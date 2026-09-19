import { verifyArticleSyncRequest } from "../../../../lib/article-sync";
import { PrivateVideoError, privateVideoKeyStatus, privateVideoSyncPublicKey } from "../../../../lib/private-videos";
import { privateVideoOssStatus } from "../../../../lib/oss-private-videos";
import { boundedVideoSyncJSON, PRIVATE_VIDEO_SYNC_PROTOCOL, receivePrivateVideoAsset } from "../../../../lib/private-video-sync";
import { VideoError } from "../../../../lib/video-download.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

function guard(request: Request) {
  if (!verifyArticleSyncRequest(request)) return json({ error: "unauthorized" }, 401);
  // Behind Nginx, overwrite X-Forwarded-Proto from $scheme and bind Next to
  // loopback. Never expose this backend directly as an alternative HTTP origin.
  if (new URL(request.url).protocol !== "https:" && request.headers.get("x-forwarded-proto") !== "https") {
    return json({ detail: "私密视频同步必须使用 HTTPS。" }, 400);
  }
  return null;
}
function failure(error: unknown) {
  return json({ detail: error instanceof PrivateVideoError || error instanceof VideoError ? error.message : "私密视频同步失败，请检查远端密钥、私有 OSS 读取权限和数据库。" }, error instanceof PrivateVideoError ? error.status : error instanceof VideoError ? 422 : 500);
}
export async function GET(request: Request) {
  const denied = guard(request); if (denied) return denied;
  try {
    for (const status of [privateVideoKeyStatus(), privateVideoOssStatus()]) {
      if (!status.ready) throw new PrivateVideoError(status.message, 503);
    }
    return json({ protocol: PRIVATE_VIDEO_SYNC_PROTOCOL, ...privateVideoSyncPublicKey() });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const denied = guard(request); if (denied) return denied;
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ detail: "同步请求必须使用 JSON。" }, 415);
  try { return json({ protocol: PRIVATE_VIDEO_SYNC_PROTOCOL, ...await receivePrivateVideoAsset(await boundedVideoSyncJSON(request)) }); }
  catch (error) { return failure(error); }
}
