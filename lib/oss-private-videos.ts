import OSS from "ali-oss";
import { VideoError, LIMITS } from "./video-download.mjs";
import { validatePrivateVideoManifest, type PrivateVideoAsset } from "./private-videos";

export type PrivateVideoDescriptor = Pick<PrivateVideoAsset, "id" | "objectPrefix" | "bucket" | "region" | "manifest">;
export const PRIVATE_VIDEO_SIGNED_URL_SECONDS = 60;
const REQUEST_TIMEOUT = 60_000;
const VERIFY_TIMEOUT = 5 * 60_000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new VideoError(`私密视频 OSS 配置不完整：缺少 ${name}。`);
  return value;
}

export function privateVideoOssConfiguration() {
  const bucket = required("OSS_BUCKET"), region = required("OSS_REGION");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new VideoError("OSS_BUCKET 格式无效。");
  if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) throw new VideoError("OSS_REGION 格式无效，例如 oss-cn-hangzhou。");
  const prefix = process.env.PRIVATE_VIDEO_OSS_PREFIX?.trim() || "private-videos";
  if (prefix.length > 200 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) throw new VideoError("PRIVATE_VIDEO_OSS_PREFIX 必须为独立的安全目录名称。");
  const publicPrefixes = [process.env.OSS_ARTICLE_VIDEO_PREFIX?.trim() || "article-videos", process.env.OSS_ARTICLE_IMAGE_PREFIX?.trim() || "article-images"].map(value => value.replace(/^\/+|\/+$/g, ""));
  if (publicPrefixes.some(publicPrefix => prefix === publicPrefix || prefix.startsWith(`${publicPrefix}/`) || publicPrefix.startsWith(`${prefix}/`))) throw new VideoError("私密视频目录不得与已有公开图片或视频目录重叠。");
  return {
    bucket, region, prefix, origin: `https://${bucket}.${region}.aliyuncs.com`,
    options: {
      accessKeyId: required("OSS_ACCESS_KEY_ID"), accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
      bucket, region, endpoint: `https://${region}.aliyuncs.com`, cname: false, secure: true,
      authorizationV4: true, timeout: REQUEST_TIMEOUT, retryMax: 2,
    },
  };
}

/** No network reads or storage mutations. Playback does not depend on the upload rollout flag. */
export function privateVideoOssStatus() {
  try { privateVideoOssConfiguration(); return { ready: true, message: "" }; }
  catch (error) { return { ready: false, message: error instanceof VideoError ? error.message : "私密视频 OSS 配置暂时不可用。" }; }
}

function checkedAsset(asset: PrivateVideoDescriptor) {
  const config = privateVideoOssConfiguration();
  if (!ID.test(asset.id) || asset.bucket !== config.bucket || asset.region !== config.region || asset.objectPrefix !== `${config.prefix}/${asset.id}`) {
    throw new VideoError("私密视频存储目录、Bucket 或地域与本站配置不一致，无法访问或同步。");
  }
  return { config, parsed: validatePrivateVideoManifest(asset.manifest) };
}

type ReadClient = Pick<OSS, "head" | "cancel" | "signatureUrlV4">;
type VerifyOptions = {
  createClient?: (options: OSS.Options) => ReadClient;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

// ali-oss cancel() only cancels multipart streams, not HEAD/PUT. Stop awaiting and
// prevent subsequent work at the task deadline even while an SDK request times out.
export function awaitPrivateVideoOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new VideoError("私密视频任务已取消或超时。"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Verify every encrypted object exists for the configured credentials, yet refuses anonymous reads. */
export async function verifyPrivateVideoAsset(asset: PrivateVideoDescriptor, options: VerifyOptions = {}) {
  const { config, parsed } = checkedAsset(asset);
  const client = (options.createClient || (settings => new OSS(settings)))(config.options);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const cancel = () => client.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? VERIFY_TIMEOUT);
  let next = 0, total = 0, firstFailure: unknown;
  try {
    const workers = Array.from({ length: Math.min(4, parsed.segments.length) }, async () => {
      while (next < parsed.segments.length) {
        signal.throwIfAborted();
        const segment = parsed.segments[next++], objectKey = `${asset.objectPrefix}/${segment.name}`;
        const result = await awaitPrivateVideoOperation(client.head(objectKey, { timeout: REQUEST_TIMEOUT }), signal);
        signal.throwIfAborted();
        const headers = result.res.headers as Record<string, string>;
        const bytes = Number(headers["content-length"]);
        if (result.status !== 200 || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > LIMITS.segment || bytes % 16) throw new VideoError("私密视频分片缺失、损坏或不可读取，请检查 OSS 读取权限。");
        total += bytes;
        if (total > LIMITS.bytes) throw new VideoError("私密视频加密资源总量超过 1 GiB。");
        const response = await (options.fetch || globalThis.fetch)(`${config.origin}/${objectKey}`, {
          method: "HEAD", redirect: "error", cache: "no-store", credentials: "omit",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (response.status !== 403) throw new VideoError("私密视频对象未能确认禁止匿名访问。请检查 Bucket 策略、对象 ACL；必要时使用独立私有 Bucket，未登记为可播放资源。");
      }
    });
    await Promise.allSettled(workers.map(worker => worker.catch(error => {
      firstFailure ??= error;
      controller.abort();
      throw error;
    })));
    if (firstFailure !== undefined) throw firstFailure;
  } catch (error) {
    if (error instanceof VideoError) throw error;
    throw new VideoError("私密视频 OSS 读取或隐私校验失败、超时，请检查 RAM 权限和网络后重试。");
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
  }
}

export async function signPrivateVideoSegment(asset: PrivateVideoDescriptor, index: number, options: { createClient?: (options: OSS.Options) => Pick<OSS, "signatureUrlV4"> } = {}) {
  const { config, parsed } = checkedAsset(asset);
  if (!Number.isInteger(index) || index < 0 || index >= parsed.segments.length) throw new VideoError("私密视频分片不存在。");
  try {
    const client = (options.createClient || (settings => new OSS(settings)))(config.options);
    return await client.signatureUrlV4("GET", PRIVATE_VIDEO_SIGNED_URL_SECONDS, {}, `${asset.objectPrefix}/${parsed.segments[index].name}`);
  } catch { throw new VideoError("私密视频播放地址暂时不可用。"); }
}
