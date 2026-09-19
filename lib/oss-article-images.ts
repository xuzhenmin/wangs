import OSS from "ali-oss";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { MAX_IMAGES_PER_ARTICLE } from "./article-image-limits";
import { detectedImageExtension } from "./article-images";
import {
  isOssArticleImageSource,
  isProcessedLocalArticleImageSource,
  isRawLocalArticleImageSource,
  ossArticleImagePrefix,
} from "./article-image-urls";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LOCAL_FILENAME_PATTERN = /^[0-9a-f]{24}\.(png|jpe?g|gif|webp)$/i;

type PublicationErrorKind = "configuration" | "validation" | "upload";

export class ArticleImagePublicationError extends Error {
  constructor(message: string, readonly kind: PublicationErrorKind) {
    super(message);
    this.name = "ArticleImagePublicationError";
  }
}

function requiredEnvironmentValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new ArticleImagePublicationError(`OSS 配置不完整：缺少 ${name}。`, "configuration");
  return value;
}

function uploadConfiguration() {
  const endpoint = process.env.OSS_ENDPOINT?.trim() || "https://oss-accelerate.aliyuncs.com";
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new ArticleImagePublicationError("OSS_ENDPOINT 不是有效 URL。", "configuration");
  }
  if (!(endpointUrl.protocol === "https:" || (process.env.OSS_ALLOW_INSECURE_ENDPOINT === "true" && endpointUrl.protocol === "http:"))) {
    throw new ArticleImagePublicationError("OSS_ENDPOINT 必须使用 HTTPS。", "configuration");
  }

  const region = requiredEnvironmentValue("OSS_REGION");
  if (!/^oss-[a-z0-9-]+$/.test(region)) {
    throw new ArticleImagePublicationError("OSS_REGION 格式无效，例如杭州应填写 oss-cn-hangzhou。", "configuration");
  }

  return {
    accessKeyId: requiredEnvironmentValue("OSS_ACCESS_KEY_ID"),
    accessKeySecret: requiredEnvironmentValue("OSS_ACCESS_KEY_SECRET"),
    bucket: requiredEnvironmentValue("OSS_BUCKET"),
    region,
    endpoint: endpointUrl.toString(),
    cname: process.env.OSS_CNAME === "true",
  };
}

function imageContentType(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

function articleImageSources(content: string) {
  const $ = load(content, null, false);
  return { $, images: $("img").toArray() };
}

function assertImageCount(count: number) {
  if (count > MAX_IMAGES_PER_ARTICLE) {
    throw new ArticleImagePublicationError(`每篇文章最多发布 ${MAX_IMAGES_PER_ARTICLE} 张图片。`, "validation");
  }
}

export function assertArticleUsesOssImages(articleId: string, content: string) {
  const { $, images } = articleImageSources(content);
  assertImageCount(images.length);
  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    if (!isOssArticleImageSource(articleId, source)) {
      throw new ArticleImagePublicationError("远端仅接收当前配置的 OSS 图片地址，请先导入图片并通过同步功能上传 OSS；水印处理可选。", "validation");
    }
  }
}

async function uploadWithRetry(client: OSS, objectKey: string, bytes: Buffer, filename: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.put(objectKey, bytes, {
        mime: imageContentType(filename),
        timeout: 60_000,
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Disposition": "inline",
        },
      });
      return;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw new ArticleImagePublicationError(`图片上传 OSS 失败：${filename}。请检查 Bucket、地域、RAM 权限和传输加速状态。`, "upload");
}

export async function publishArticleImagesToOss(articleId: string, content: string) {
  const { $, images } = articleImageSources(content);
  assertImageCount(images.length);
  const ossPrefix = ossArticleImagePrefix(articleId);
  if (!ossPrefix && images.length) {
    throw new ArticleImagePublicationError("OSS 公共访问地址配置不完整，请设置 OSS_BUCKET 或 OSS_PUBLIC_BASE_URL。", "configuration");
  }

  const localSources = new Map<string, { filename: string; filePath: string; targetUrl: string }>();
  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    if (isOssArticleImageSource(articleId, source)) continue;
    const raw = isRawLocalArticleImageSource(articleId, source);
    if (!raw && !isProcessedLocalArticleImageSource(articleId, source)) {
      throw new ArticleImagePublicationError("本地文章已发布，但暂不能同步远端：正文仍有外链、Blob 或不属于当前文章的图片，请先将图片导入当前文章后重试同步；无需进行水印处理。", "validation");
    }
    const localPrefix = raw ? `/uploads/articles/${articleId}/` : `/article-images/${articleId}/`;
    const filename = source.slice(localPrefix.length);
    if (!LOCAL_FILENAME_PATTERN.test(filename)) {
      throw new ArticleImagePublicationError(`本地图片文件名无效：${filename || source}`, "validation");
    }
    // Read from the original directory directly. No watermark edits, copying
    // into the processed directory, or deletion of either local version.
    const filePath = path.join(/* turbopackIgnore: true */ process.cwd(), "public", raw ? "uploads/articles" : "article-images", articleId, filename);
    localSources.set(source, { filename, filePath, targetUrl: `${ossPrefix}${filename}` });
  }

  if (!localSources.size) return { content, uploadedImageCount: 0 };

  const configuration = uploadConfiguration();
  const objectPrefix = process.env.OSS_ARTICLE_IMAGE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "article-images";
  const client = new OSS({
    accessKeyId: configuration.accessKeyId,
    accessKeySecret: configuration.accessKeySecret,
    bucket: configuration.bucket,
    region: configuration.region,
    endpoint: configuration.endpoint,
    cname: configuration.cname,
    secure: new URL(configuration.endpoint).protocol === "https:",
    authorizationV4: true,
    timeout: 60_000,
  });

  const uploadedObjects = new Map<string, string>();
  for (const { filename, filePath } of localSources.values()) {
    let bytes: Buffer;
    try {
      const file = await lstat(filePath);
      if (!file.isFile()) throw new ArticleImagePublicationError(`本地图片不是普通文件：${filename}`, "validation");
      if (!file.size || file.size > MAX_IMAGE_BYTES) throw new ArticleImagePublicationError(`本地图片为空或超过 8 MB：${filename}`, "validation");
      bytes = await readFile(filePath);
    } catch (error) {
      if (error instanceof ArticleImagePublicationError) throw error;
      throw new ArticleImagePublicationError(`找不到或无法读取本地图片：${filename}`, "validation");
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new ArticleImagePublicationError(`本地图片为空或超过 8 MB：${filename}`, "validation");
    }
    const extension = path.extname(filename).slice(1).toLowerCase().replace(/^jpeg$/, "jpg");
    if (detectedImageExtension(bytes) !== extension) throw new ArticleImagePublicationError(`本地图片内容与格式不符，仅支持 PNG、JPEG、GIF、WebP：${filename}`, "validation");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const uploadedDigest = uploadedObjects.get(filename);
    if (uploadedDigest) {
      if (uploadedDigest !== digest) throw new ArticleImagePublicationError(`原图与处理后图片同名但内容不同，请重新导入或生成图片：${filename}`, "validation");
      continue;
    }
    await uploadWithRetry(client, `${objectPrefix}/${articleId}/${filename}`, bytes, filename);
    uploadedObjects.set(filename, digest);
  }

  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    const replacement = localSources.get(source);
    if (replacement) $(image).attr("src", replacement.targetUrl);
  }
  const publishedContent = $.root().html() || content;
  assertArticleUsesOssImages(articleId, publishedContent);
  return { content: publishedContent, uploadedImageCount: uploadedObjects.size };
}
