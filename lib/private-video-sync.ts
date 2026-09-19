import { load } from "cheerio";
import {
  getPrivateVideoAsset, openPrivateVideoKey, PrivateVideoError,
  privateVideoSyncPublicKey, savePrivateVideoAsset, sealPrivateVideoKey,
  unwrapVideoKey, validatePrivateVideoAssetMetadata, wrapVideoKey,
} from "./private-videos";
import { verifyPrivateVideoAsset } from "./oss-private-videos";

export const PRIVATE_VIDEO_SYNC_PROTOCOL = "shenxiang-private-video-v1";
export const PRIVATE_VIDEO_SYNC_MAX_BYTES = 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 7 * 60_000;

export function privateVideoReferences(content: string) {
  const $ = load(content, null, false);
  return [...new Set($("video[data-private-video-id]").toArray().map(node => $(node).attr("data-private-video-id") || ""))];
}

export async function boundedVideoSyncJSON(message: Request | Response) {
  if (Number(message.headers.get("content-length")) > PRIVATE_VIDEO_SYNC_MAX_BYTES) {
    throw new PrivateVideoError("私密视频资源描述不能超过 1 MiB。", 413);
  }
  const reader = message.body?.getReader();
  if (!reader) throw new PrivateVideoError("缺少私密视频资源数据。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > PRIVATE_VIDEO_SYNC_MAX_BYTES) {
        await reader.cancel();
        throw new PrivateVideoError("私密视频资源描述不能超过 1 MiB。", 413);
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof PrivateVideoError) throw error;
    throw new PrivateVideoError("私密视频同步数据格式无效。");
  } finally { reader.releaseLock(); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateVideoError("私密视频同步数据格式无效。");
  return value as Record<string, unknown>;
}

// Only receive envelopes for this deployment. Codes/sessions never travel with
// content, and a received key is rewrapped under this server's independent key.
export async function receivePrivateVideoAsset(value: unknown) {
  const body = object(value);
  if (body.protocol !== PRIVATE_VIDEO_SYNC_PROTOCOL) throw new PrivateVideoError("私密视频同步协议不兼容，请更新两端服务。");
  const keys = privateVideoSyncPublicKey();
  if (body.recipientKeyId !== keys.keyId) throw new PrivateVideoError("远端同步密钥已变化，请重新发起文章同步。");
  if (typeof body.encryptedKey !== "string" || body.encryptedKey.length > 2048) throw new PrivateVideoError("视频密钥封装数据无效。");
  const metadata = validatePrivateVideoAssetMetadata(body.asset);
  const key = openPrivateVideoKey(body.encryptedKey);
  try {
    const asset = { ...metadata, wrappedKey: wrapVideoKey(metadata.id, key) };
    // The receiver must be able to read the encrypted objects in its configured
    // OSS namespace; it must never fetch arbitrary remote URLs from a descriptor.
    await verifyPrivateVideoAsset(asset);
    const saved = savePrivateVideoAsset(asset);
    return { id: saved.id };
  } finally { key.fill(0); }
}

export async function syncPrivateVideosBeforeArticle(content: string, articleEndpoint: URL, secret: string) {
  const ids = privateVideoReferences(content);
  if (!ids.length) return;
  if (articleEndpoint.protocol !== "https:") throw new PrivateVideoError("含私密视频的文章只能通过 HTTPS 同步，请填写远端 HTTPS 网址。");
  const endpoint = new URL(articleEndpoint);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/private-videos`;
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "User-Agent": "Shenxiang-Private-Video-Sync/1.0" };
  const exchange = async (body?: unknown) => {
    const response = await fetch(endpoint, {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405) throw new PrivateVideoError("远端不支持私密视频同步，请更新远端代码后重试；未回退到公开视频。");
    if (response.status === 401) throw new PrivateVideoError("远端拒绝同步，请检查两端 ARTICLE_SYNC_SECRET 是否一致。");
    if (response.status === 413) throw new PrivateVideoError("远端拒绝视频资源描述体积，请检查 Nginx client_max_body_size（至少 2m）。");
    const data = object(await boundedVideoSyncJSON(response));
    if (!response.ok) throw new PrivateVideoError(typeof data.detail === "string" ? data.detail.slice(0, 500) : `远端私密视频接口返回 HTTP ${response.status}。`);
    return data;
  };
  const capabilities = await exchange();
  if (capabilities.protocol !== PRIVATE_VIDEO_SYNC_PROTOCOL || typeof capabilities.publicKey !== "string"
    || capabilities.publicKey.length > 8192 || typeof capabilities.keyId !== "string" || capabilities.keyId.length > 128) {
    throw new PrivateVideoError("远端私密视频同步能力或公钥无效，请更新远端配置。");
  }
  for (const id of ids) {
    const asset = getPrivateVideoAsset(id);
    if (!asset) throw new PrivateVideoError("正文引用的私密视频尚未准备完成，请先完成加密上传。");
    const { wrappedKey: _wrappedKey, ...metadata } = asset;
    void _wrappedKey;
    const key = unwrapVideoKey(asset);
    try {
      const payload = {
        protocol: PRIVATE_VIDEO_SYNC_PROTOCOL, recipientKeyId: capabilities.keyId,
        asset: metadata, encryptedKey: sealPrivateVideoKey(capabilities.publicKey, key),
      };
      if (Buffer.byteLength(JSON.stringify(payload)) > PRIVATE_VIDEO_SYNC_MAX_BYTES) throw new PrivateVideoError("视频资源描述过大，无法同步。");
      const result = await exchange(payload);
      if (result.id !== id || result.protocol !== PRIVATE_VIDEO_SYNC_PROTOCOL) throw new PrivateVideoError("远端未确认私密视频已就绪，已停止文章同步。");
    } finally { key.fill(0); }
  }
}
