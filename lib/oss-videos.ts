import OSS from "ali-oss";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { VideoError, LIMITS } from "./video-download.mjs";
import { getVideoJob, setVideoPublication, videoFile, videoRoot, type VideoJob, type VideoPublication } from "./video-imports.mjs";
import { packagePrivateVideo, type PackagedPrivateVideo } from "../scripts/private-video-package.mjs";
import { getPrivateVideoAsset, savePrivateVideoAsset, wrapVideoKey, unwrapVideoKey, privateVideoKeyStatus, validatePrivateVideoManifest, type PrivateVideoAsset } from "./private-videos";
import { awaitPrivateVideoOperation, privateVideoOssConfiguration, verifyPrivateVideoAsset } from "./oss-private-videos";

const REQUEST_TIMEOUT = 60_000;
const UPLOAD_TIMEOUT = 30 * 60_000;
const QUEUE_KEY = Symbol.for("shenxiang.video-oss-queue.v1");

function configuration() {
  const config = privateVideoOssConfiguration();
  if (process.env.PRIVATE_VIDEO_UPLOAD_ENABLED !== "true") throw new VideoError("私密视频上传尚未启用。请完成密钥、私有 OSS 权限及播放器配置后设置 PRIVATE_VIDEO_UPLOAD_ENABLED=true；不会回退到公开上传。");
  const keyStatus = privateVideoKeyStatus();
  if (!keyStatus.ready) throw new VideoError(keyStatus.message);
  return config;
}

export function videoOssStatus() {
  try { configuration(); return { ready: true, message: "" }; }
  catch (error) { return { ready: false, message: error instanceof VideoError ? error.message : "私密视频配置暂时不可用。" }; }
}

function uploadFailure(error: unknown) {
  if (error instanceof VideoError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "SecurityTokenExpired"].includes(code)) return new VideoError("OSS 拒绝上传，请检查服务端密钥、RAM 上传及设置私有对象 ACL 的权限、Bucket 和地域配置。");
  if (["RequestTimeout", "ConnectionTimeoutError", "ETIMEDOUT", "TimeoutError"].includes(code)) return new VideoError("私密视频 OSS 请求超时，请检查网络后重试。");
  return new VideoError("私密视频上传失败，请检查网络、私有对象 ACL、RAM 权限、密钥和数据库配置后重试；本地原视频仍然保留。");
}

type AssetReadOptions = { findAsset?: typeof getPrivateVideoAsset; unwrapKey?: typeof unwrapVideoKey };

function assertAssetKey(asset: PrivateVideoAsset, options: AssetReadOptions) {
  try {
    const key = (options.unwrapKey || unwrapVideoKey)(asset);
    key.fill(0);
  } catch { throw new VideoError("已上传的私密视频密钥无法解密。请恢复原数据库及主密钥备份，或重新导入为新任务；不会覆盖原视频资源。"); }
}

function alreadyPublished(job: VideoJob, options: AssetReadOptions = {}) {
  if (job.publication?.status !== "uploaded") return false;
  // Existing public objects remain unchanged even after private uploads are enabled.
  if (job.publication.kind !== "private") return typeof job.publication.url === "string" && job.publication.url.length > 0;
  const asset = (options.findAsset || getPrivateVideoAsset)(job.id);
  if (job.publication.assetId !== job.id || !asset) throw new VideoError("已上传的私密视频缺少本机资源记录。请恢复原数据库及主密钥备份，或重新导入为新任务；不会覆盖原视频资源。");
  assertAssetKey(asset, options);
  return true;
}

type UploadClient = Pick<OSS, "put" | "cancel">;
type UploadOptions = AssetReadOptions & {
  progress?: (value: number) => void;
  createClient?: (options: OSS.Options) => UploadClient;
  packageVideo?: typeof packagePrivateVideo;
  verifyPrivate?: typeof verifyPrivateVideoAsset;
  saveAsset?: typeof savePrivateVideoAsset;
  wrapKey?: typeof wrapVideoKey;
  timeoutMs?: number;
};

/** New uploads are always encrypted; dependency seams allow synthetic tests without OSS/user media. */
export async function uploadVideoFileToOss(job: VideoJob, options: UploadOptions = {}): Promise<VideoPublication> {
  if (alreadyPublished(job, options)) return job.publication!;
  const config = configuration();
  const existing = (options.findAsset || getPrivateVideoAsset)(job.id);
  if (existing) {
    // Recover a process interruption after resource registration but before job metadata was saved.
    assertAssetKey(existing, options);
    await (options.verifyPrivate || verifyPrivateVideoAsset)(existing);
    return { kind: "private", assetId: job.id, status: "uploaded", progress: 100, uploadedAt: existing.createdAt };
  }
  const file = videoFile(job.id);
  if (!file || job.status !== "completed") throw new VideoError("只有已完成的视频可以上传 OSS。");
  try {
    const [fileInfo, resolvedFile, resolvedRoot] = await Promise.all([lstat(file), realpath(file), realpath(videoRoot())]);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || resolvedFile !== path.join(resolvedRoot, job.id, "video.mp4")) throw new Error("invalid file");
    if (fileInfo.size <= 0 || fileInfo.size >= LIMITS.bytes || fileInfo.size !== job.fileBytes) throw new Error("invalid size");
  } catch { throw new VideoError("本地完整视频不存在、文件已改变或超过 1 GiB，请先重新完成视频下载。"); }

  const controller = new AbortController();
  const client = (options.createClient || (settings => new OSS(settings)))(config.options);
  let expired = false, packaged: PackagedPrivateVideo | undefined;
  const timer = setTimeout(() => { expired = true; controller.abort(); client.cancel(); }, options.timeoutMs ?? UPLOAD_TIMEOUT);
  try {
    options.progress?.(1);
    packaged = await (options.packageVideo || packagePrivateVideo)(file, { signal: controller.signal });
    controller.signal.throwIfAborted();
    const parsed = validatePrivateVideoManifest(packaged.manifest);
    if (parsed.segments.length !== packaged.segments.length) throw new VideoError("加密播放清单与分片数量不一致，已停止上传。");
    const total = packaged.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    if (total <= 0 || total > LIMITS.bytes) throw new VideoError("加密分片总量超过 1 GiB，请先压缩原视频。");
    const objectPrefix = `${config.prefix}/${job.id}`;
    let uploaded = 0;
    for (const [index, segment] of packaged.segments.entries()) {
      controller.signal.throwIfAborted();
      if (segment.name !== parsed.segments[index].name || segment.bytes <= 0 || segment.bytes > LIMITS.segment || segment.bytes % 16) throw new VideoError("加密分片验证失败，已停止上传。");
      // Only encrypted .ts files are sent. Neither key.bin, playlist nor original MP4 is uploaded.
      await awaitPrivateVideoOperation(client.put(`${objectPrefix}/${segment.name}`, segment.file, {
        timeout: REQUEST_TIMEOUT, mime: "video/mp2t",
        headers: { "x-oss-object-acl": "private", "Cache-Control": "private, no-store", "Content-Disposition": "inline" },
      }), controller.signal);
      uploaded += segment.bytes;
      options.progress?.(Math.min(95, 5 + Math.floor(uploaded / total * 90)));
    }
    const descriptor = { id: job.id, objectPrefix, bucket: config.bucket, region: config.region, manifest: parsed.manifest, createdAt: Date.now() };
    await (options.verifyPrivate || verifyPrivateVideoAsset)(descriptor, { signal: controller.signal });
    controller.signal.throwIfAborted();
    const asset: PrivateVideoAsset = { ...descriptor, wrappedKey: (options.wrapKey || wrapVideoKey)(job.id, packaged.key) };
    (options.saveAsset || savePrivateVideoAsset)(asset);
    return { kind: "private", assetId: asset.id, status: "uploaded", progress: 100, uploadedAt: asset.createdAt };
  } catch (error) {
    client.cancel();
    if (expired) throw new VideoError("私密视频加密及上传超过 30 分钟时限，请检查网络后重试。");
    // Failed attempts may leave private ciphertext only; never delete completed OSS objects or originals.
    throw uploadFailure(error);
  } finally {
    clearTimeout(timer);
    if (packaged) await packaged.cleanup();
  }
}

type QueueEntry = { id: string; upload: typeof uploadVideoFileToOss };
type Queue = { entries: QueueEntry[]; running: boolean };
function queue(): Queue {
  const global = globalThis as typeof globalThis & { [QUEUE_KEY]?: Queue };
  return global[QUEUE_KEY] ||= { entries: [], running: false };
}

export function enqueueVideoOssUpload(id: string, authorized: unknown, upload = uploadVideoFileToOss, assetOptions: AssetReadOptions = {}) {
  if (authorized !== true) throw new VideoError("请确认你有权将此视频上传 OSS 并提供给获准观看者。");
  const job = getVideoJob(id);
  if (!job) return null;
  if (job.status !== "completed") throw new VideoError("只有已完成的视频可以上传 OSS。");
  if (job.publication?.status === "uploading" || alreadyPublished(job, assetOptions)) return job;
  configuration();
  const state = queue();
  if (state.entries.length >= 12) throw new VideoError("OSS 上传队列已满（最多 12 个），请稍后重试。");
  setVideoPublication(id, { kind: "private", assetId: id, status: "uploading", progress: 0 });
  state.entries.push({ id, upload });
  void drainUploads();
  return job;
}

async function drainUploads() {
  const state = queue();
  if (state.running) return;
  state.running = true;
  try {
    while (state.entries.length) {
      const entry = state.entries[0], job = getVideoJob(entry.id);
      try {
        if (!job) continue;
        const publication = await entry.upload(job, { progress: progress => {
          if (job.publication?.progress !== progress) setVideoPublication(job.id, { kind: "private", assetId: job.id, status: "uploading", progress });
        } });
        setVideoPublication(job.id, publication);
      } catch (error) {
        if (job) {
          const publication: VideoPublication = { kind: "private", assetId: job.id, status: "failed", progress: job.publication?.progress || 0, error: uploadFailure(error).message };
          try { setVideoPublication(job.id, publication); } catch { job.publication = publication; }
        }
      } finally { state.entries.shift(); }
    }
  } finally { state.running = false; }
}
