import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../db";

export class PrivateVideoError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "PrivateVideoError"; }
}
export type PrivateVideoAssetMetadata = {
  id: string; objectPrefix: string; bucket: string; region: string; manifest: string; createdAt: number;
};
export type PrivateVideoAsset = PrivateVideoAssetMetadata & { wrappedKey: string };
export const PRIVATE_VIDEO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function masterKey() {
  const value = process.env.PRIVATE_VIDEO_MASTER_KEY || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new PrivateVideoError("请配置独立的 PRIVATE_VIDEO_MASTER_KEY（32 字节随机密钥的 Base64）。", 503);
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw new PrivateVideoError("PRIVATE_VIDEO_MASTER_KEY 格式无效。", 503);
  return key;
}
export function privateVideoKeyStatus() {
  try { const key = masterKey(); key.fill(0); return { ready: true, message: "私密视频密钥已配置。" }; }
  catch (error) { return { ready: false, message: error instanceof PrivateVideoError ? error.message : "私密视频密钥不可用。" }; }
}

export function wrapVideoKey(id: string, key: Uint8Array) {
  if (!PRIVATE_VIDEO_ID.test(id) || key.byteLength !== 16) throw new PrivateVideoError("视频密钥参数无效。");
  const master = masterKey();
  try {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(Buffer.from(`private-video-v1:${id}`));
    const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  } finally { master.fill(0); }
}

export function unwrapVideoKey(asset: Pick<PrivateVideoAsset, "id" | "wrappedKey">) {
  if (!PRIVATE_VIDEO_ID.test(asset.id) || typeof asset.wrappedKey !== "string" || asset.wrappedKey.length > 128) throw new PrivateVideoError("视频密钥不可用。", 503);
  const parts = asset.wrappedKey.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !parts.slice(1).every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new PrivateVideoError("视频密钥不可用。", 503);
  const [iv, encrypted, tag] = parts.slice(1).map(part => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || encrypted.length !== 16 || tag.length !== 16) throw new PrivateVideoError("视频密钥不可用。", 503);
  const master = masterKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", master, iv);
    decipher.setAAD(Buffer.from(`private-video-v1:${asset.id}`)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch { throw new PrivateVideoError("视频密钥不可用，请检查本机密钥配置或备份。", 503); }
  finally { master.fill(0); }
}

/** Accept only the bounded, single-key VOD format we produce. No remote URLs or arbitrary HLS tags. */
export function validatePrivateVideoManifest(input: unknown) {
  if (typeof input !== "string" || Buffer.byteLength(input) > MAX_MANIFEST_BYTES || /[^\x09\x0a\x0d\x20-\x7e]/.test(input)) throw new PrivateVideoError("私密视频播放清单无效。");
  const lines = input.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] !== "#EXTM3U" || lines.at(-1) !== "#EXT-X-ENDLIST") throw new PrivateVideoError("仅支持完整的私密视频 VOD 清单。");
  const segments: { name: string; duration: number }[] = [];
  const tags = new Set<string>(); let pendingDuration: number | null = null; let duration = 0; let target = 0; let keySeen = false;
  for (const line of lines.slice(1, -1)) {
    if (pendingDuration !== null) {
      const expected = `segment-${String(segments.length).padStart(5, "0")}.ts`;
      if (line !== expected || segments.length >= 10000) throw new PrivateVideoError("私密视频分片名称或数量无效。");
      segments.push({ name: line, duration: pendingDuration }); duration += pendingDuration; pendingDuration = null; continue;
    }
    if (line.startsWith("#EXTINF:")) {
      if (!keySeen || !/^#EXTINF:\d+(?:\.\d{1,9})?,$/.test(line)) throw new PrivateVideoError("私密视频分片时长无效。");
      pendingDuration = Number(line.slice(8, -1));
      if (!(pendingDuration > 0 && pendingDuration <= 120)) throw new PrivateVideoError("私密视频分片时长超限。");
      continue;
    }
    const name = line.split(":")[0];
    if (tags.has(name) || segments.length) throw new PrivateVideoError("私密视频清单包含重复或不支持的标记。");
    tags.add(name);
    if (/^#EXT-X-VERSION:[3-7]$/.test(line) || line === "#EXT-X-MEDIA-SEQUENCE:0" || line === "#EXT-X-PLAYLIST-TYPE:VOD" || line === "#EXT-X-INDEPENDENT-SEGMENTS" || line === "#EXT-X-ALLOW-CACHE:YES") continue;
    if (/^#EXT-X-TARGETDURATION:\d{1,3}$/.test(line)) { target = Number(line.split(":")[1]); if (target < 1 || target > 120) throw new PrivateVideoError("视频目标分片时长无效。"); continue; }
    if (/^#EXT-X-KEY:METHOD=AES-128,URI="key\.bin",IV=0x[0-9a-fA-F]{32}$/.test(line)) { keySeen = true; continue; }
    throw new PrivateVideoError("私密视频清单包含不允许的地址或标记。");
  }
  if (pendingDuration !== null || !segments.length || !keySeen || !target || !tags.has("#EXT-X-MEDIA-SEQUENCE") || !tags.has("#EXT-X-PLAYLIST-TYPE") || !tags.has("#EXT-X-VERSION") || duration > 7200 || segments.some(segment => Math.round(segment.duration) > target)) throw new PrivateVideoError("私密视频清单不完整或时长超限。");
  return { manifest: `${lines.join("\n")}\n`, segments, duration };
}

export function validatePrivateVideoAssetMetadata(value: unknown): PrivateVideoAssetMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateVideoError("私密视频资源参数无效。");
  const asset = value as Record<string, unknown>;
  if (typeof asset.id !== "string" || !PRIVATE_VIDEO_ID.test(asset.id) || typeof asset.objectPrefix !== "string" || asset.objectPrefix.length > 300 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/.test(asset.objectPrefix) || !asset.objectPrefix.endsWith(`/${asset.id}`) || typeof asset.bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(asset.bucket) || typeof asset.region !== "string" || !/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(asset.region) || !Number.isSafeInteger(asset.createdAt) || Number(asset.createdAt) < 1 || Number(asset.createdAt) > Date.now() + 5 * 60 * 1000) throw new PrivateVideoError("私密视频资源参数无效。");
  return { id: asset.id, objectPrefix: asset.objectPrefix, bucket: asset.bucket, region: asset.region, manifest: validatePrivateVideoManifest(asset.manifest).manifest, createdAt: Number(asset.createdAt) };
}

export function getPrivateVideoAsset(id: string): PrivateVideoAsset | null {
  if (!PRIVATE_VIDEO_ID.test(id)) return null;
  const row = getDb().prepare("SELECT id, object_prefix AS objectPrefix, bucket, region, manifest, wrapped_key AS wrappedKey, created_at AS createdAt FROM private_video_assets WHERE id = ?").get(id);
  return row ? { ...row } as unknown as PrivateVideoAsset : null;
}

export function savePrivateVideoAsset(input: PrivateVideoAsset): PrivateVideoAsset {
  const asset = { ...validatePrivateVideoAssetMetadata(input), wrappedKey: input.wrappedKey };
  const key = unwrapVideoKey(asset);
  const db = getDb(); db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getPrivateVideoAsset(asset.id);
    if (existing) {
      const previousKey = unwrapVideoKey(existing);
      try {
        const metadataMatches = ["objectPrefix", "bucket", "region", "manifest", "createdAt"].every(field => existing[field as keyof PrivateVideoAsset] === asset[field as keyof PrivateVideoAsset]);
        if (!metadataMatches || !timingSafeEqual(previousKey, key)) throw new PrivateVideoError("同一视频资源已存在且内容不同，请创建新的资源。", 409);
      } finally { previousKey.fill(0); }
      db.exec("COMMIT"); return existing;
    }
    db.prepare("INSERT INTO private_video_assets (id, object_prefix, bucket, region, manifest, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(asset.id, asset.objectPrefix, asset.bucket, asset.region, asset.manifest, asset.wrappedKey, asset.createdAt);
    db.exec("COMMIT"); return asset;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { key.fill(0); }
}

function syncPrivateKey() {
  try {
    const encoded = process.env.PRIVATE_VIDEO_SYNC_PRIVATE_KEY || "";
    if (!encoded || encoded.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const key = createPrivateKey(Buffer.from(encoded, "base64"));
    if (key.asymmetricKeyType !== "rsa" || Number(key.asymmetricKeyDetails?.modulusLength) < 2048) throw new Error();
    return key;
  } catch { throw new PrivateVideoError("请配置本机 PRIVATE_VIDEO_SYNC_PRIVATE_KEY（至少 2048 位 RSA 私钥 PEM 的 Base64）。", 503); }
}
export function privateVideoSyncPublicKey() {
  const key = createPublicKey(syncPrivateKey());
  const publicKey = key.export({ format: "pem", type: "spki" }).toString();
  return { publicKey, keyId: createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex") };
}
export function sealPrivateVideoKey(publicKey: string, key: Uint8Array) {
  try {
    if (typeof publicKey !== "string" || publicKey.length > 8192 || key.byteLength !== 16) throw new Error();
    const recipient = createPublicKey(publicKey);
    if (recipient.asymmetricKeyType !== "rsa" || Number(recipient.asymmetricKeyDetails?.modulusLength) < 2048) throw new Error();
    return publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64");
  } catch { throw new PrivateVideoError("远端视频同步公钥无效。", 422); }
}
export function openPrivateVideoKey(envelope: string) {
  const key = syncPrivateKey();
  try {
    if (typeof envelope !== "string" || envelope.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope)) throw new Error();
    const plaintext = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope, "base64"));
    if (plaintext.length !== 16) { plaintext.fill(0); throw new Error(); }
    return plaintext;
  } catch { throw new PrivateVideoError("视频密钥包无法验证，请重新发起同步。", 422); }
}
