import OSS from "ali-oss";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { VideoError, LIMITS } from "./video-download.mjs";
import { getVideoJob, setVideoPublication, videoFile, videoRoot, type VideoJob } from "./video-imports.mjs";
import { isOssArticleVideoSource, ossArticleVideoBaseUrl, ossArticleVideoObjectPrefix } from "./article-video-urls";

const REQUEST_TIMEOUT = 60_000;
const UPLOAD_TIMEOUT = 30 * 60_000;
const QUEUE_KEY = Symbol.for("shenxiang.video-oss-queue.v1");

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new VideoError(`OSS 配置不完整：缺少 ${name}。`);
  return value;
}

function configuration() {
  let endpoint: URL;
  try { endpoint = new URL(process.env.OSS_ENDPOINT?.trim() || "https://oss-accelerate.aliyuncs.com"); }
  catch { throw new VideoError("OSS_ENDPOINT 不是有效 URL。"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new VideoError("视频上传的 OSS_ENDPOINT 必须为不含凭据和路径的 HTTPS 地址。");
  }
  const region = required("OSS_REGION");
  if (!/^oss-[a-z0-9-]+$/.test(region)) throw new VideoError("OSS_REGION 格式无效，例如 oss-cn-hangzhou。");
  const bucket = required("OSS_BUCKET");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new VideoError("OSS_BUCKET 格式无效。");
  const publicBase = ossArticleVideoBaseUrl();
  const prefix = ossArticleVideoObjectPrefix();
  if (!publicBase || !prefix) throw new VideoError("OSS 视频公共地址或目录无效，请检查 OSS_PUBLIC_BASE_URL、OSS_BUCKET 和 OSS_ARTICLE_VIDEO_PREFIX。");
  return {
    publicBase, prefix,
    options: {
      accessKeyId: required("OSS_ACCESS_KEY_ID"), accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
      bucket, region, endpoint: endpoint.toString(), cname: process.env.OSS_CNAME === "true",
      secure: true, authorizationV4: true, timeout: REQUEST_TIMEOUT, retryMax: 2,
    },
  };
}

export function videoOssStatus() {
  try { configuration(); return { ready: true, message: "" }; }
  catch (error) { return { ready: false, message: error instanceof VideoError ? error.message : "OSS 配置暂时不可用。" }; }
}

function uploadFailure(error: unknown) {
  if (error instanceof VideoError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "SecurityTokenExpired"].includes(code)) {
    return new VideoError("OSS 拒绝上传，请检查服务端密钥、RAM 分片上传权限、Bucket 和地域配置。");
  }
  if (["RequestTimeout", "ConnectionTimeoutError", "ETIMEDOUT", "TimeoutError"].includes(code)) return new VideoError("OSS 上传请求超时，请检查网络后重试。");
  return new VideoError("视频上传 OSS 失败，请检查网络、Bucket、地域、RAM 分片上传权限和传输加速配置后重试。");
}

async function verifyPublicVideo(url: string, bytes: number) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const length = response.headers.get("content-length");
    if (response.status !== 200 || (length && Number(length) !== bytes) || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") || "")) {
      throw new Error("unreadable");
    }
  } catch {
    throw new VideoError("文件已上传，但 OSS 公共链接无法匿名读取为完整 MP4。请检查公共读取权限、CDN/加速域名、防盗链和 HTTPS 配置后重试；本地视频仍然保留。");
  }
}

type UploadClient = Pick<OSS, "multipartUpload" | "cancel" | "abortMultipartUpload">;
type UploadOptions = {
  progress?: (value: number) => void;
  createClient?: (options: OSS.Options) => UploadClient;
  verifyPublic?: (url: string, bytes: number) => Promise<void>;
  timeoutMs?: number;
};

// Server-only dependency seams allow synthetic tests without OSS credentials, buckets or user media.
export async function uploadVideoFileToOss(job: VideoJob, options: UploadOptions = {}) {
  const config = configuration();
  const file = videoFile(job.id);
  if (!file || job.status !== "completed") throw new VideoError("只有已完成的视频可以上传 OSS。");
  try {
    const [fileInfo, resolvedFile, resolvedRoot] = await Promise.all([lstat(file), realpath(file), realpath(videoRoot())]);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || resolvedFile !== path.join(resolvedRoot, job.id, "video.mp4")) throw new Error("invalid file");
    if (fileInfo.size <= 0 || fileInfo.size >= LIMITS.bytes || fileInfo.size !== job.fileBytes) throw new Error("invalid size");
  } catch { throw new VideoError("本地完整视频不存在、文件已改变或超过 1 GiB，请先重新完成视频下载。"); }

  const objectKey = `${config.prefix}/${job.id}/video.mp4`;
  const url = `${config.publicBase}/${job.id}/video.mp4`;
  const client = (options.createClient || (settings => new OSS(settings)))(config.options);
  let uploadId: string | undefined;
  let expired = false;
  let completed = false;
  const timer = setTimeout(() => { expired = true; client.cancel(); }, options.timeoutMs ?? UPLOAD_TIMEOUT);
  try {
    await client.multipartUpload(objectKey, file, {
      parallel: 1, partSize: 8 * 1024 * 1024, timeout: REQUEST_TIMEOUT, mime: "video/mp4",
      headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Disposition": "inline" },
      progress: async (fraction: number, checkpoint?: OSS.Checkpoint) => {
        if (checkpoint?.uploadId) uploadId = checkpoint.uploadId;
        if (expired) throw new VideoError("OSS 上传超过 30 分钟时限，请检查网络后重试。");
        if (Number.isFinite(fraction)) options.progress?.(Math.max(0, Math.min(99, Math.floor(fraction * 100))));
      },
    });
    completed = true;
    if (expired) throw new VideoError("OSS 上传超过 30 分钟时限，请检查网络后重试。");
    await (options.verifyPublic || verifyPublicVideo)(url, job.fileBytes!);
    return { status: "uploaded" as const, progress: 100, url, objectKey, uploadedAt: Date.now() };
  } catch (error) {
    client.cancel();
    if (uploadId && !completed) {
      // Only abort this task's known multipart upload. Never delete completed objects or local files.
      await client.abortMultipartUpload(objectKey, uploadId, { timeout: 15_000 }).catch(() => {});
    }
    if (expired) throw new VideoError("OSS 上传超过 30 分钟时限，请检查网络后重试。");
    throw uploadFailure(error);
  } finally { clearTimeout(timer); }
}

type QueueEntry = { id: string; upload: typeof uploadVideoFileToOss };
type Queue = { entries: QueueEntry[]; running: boolean };
function queue(): Queue {
  const global = globalThis as typeof globalThis & { [QUEUE_KEY]?: Queue };
  return global[QUEUE_KEY] ||= { entries: [], running: false };
}

export function enqueueVideoOssUpload(id: string, authorized: unknown, upload = uploadVideoFileToOss) {
  if (authorized !== true) throw new VideoError("请确认你有权将此视频上传 OSS 并在文章中公开使用。");
  const job = getVideoJob(id);
  if (!job) return null;
  if (job.status !== "completed") throw new VideoError("只有已完成的视频可以上传 OSS。");
  if (job.publication?.status === "uploading" || (job.publication?.status === "uploaded" && isOssArticleVideoSource(job.publication.url || ""))) return job;
  configuration();
  const state = queue();
  if (state.entries.length >= 12) throw new VideoError("OSS 上传队列已满（最多 12 个），请稍后重试。");
  setVideoPublication(id, { status: "uploading", progress: 0 });
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
      const entry = state.entries[0];
      const job = getVideoJob(entry.id);
      try {
        if (!job) continue;
        const publication = await entry.upload(job, {
          progress: progress => {
            if (job.publication?.progress === progress) return;
            setVideoPublication(job.id, { status: "uploading", progress });
          },
        });
        setVideoPublication(job.id, publication);
      } catch (error) {
        if (job) {
          const publication = { status: "failed" as const, progress: job.publication?.progress || 0, error: uploadFailure(error).message };
          try { setVideoPublication(job.id, publication); } catch { job.publication = publication; }
        }
      } finally { state.entries.shift(); }
    }
  } finally { state.running = false; }
}
