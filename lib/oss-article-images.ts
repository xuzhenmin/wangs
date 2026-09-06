import OSS from "ali-oss";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import {
  isOssArticleImageSource,
  isProcessedLocalArticleImageSource,
  isRawLocalArticleImageSource,
  ossArticleImagePrefix,
} from "./article-image-urls";

const MAX_ARTICLE_IMAGES = 50;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PROCESSED_FILENAME_PATTERN = /^[0-9a-f]{24}\.(png|jpe?g|gif|webp)$/i;

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
  if (count > MAX_ARTICLE_IMAGES) {
    throw new ArticleImagePublicationError(`每篇文章最多发布 ${MAX_ARTICLE_IMAGES} 张图片。`, "validation");
  }
}

export function assertArticleUsesOssImages(articleId: string, content: string) {
  const { $, images } = articleImageSources(content);
  assertImageCount(images.length);
  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    if (!isOssArticleImageSource(articleId, source)) {
      throw new ArticleImagePublicationError("正文图片尚未发布到当前配置的 OSS，请先在本地重新发布文章。", "validation");
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

export async function publishProcessedArticleImagesToOss(articleId: string, content: string) {
  const { $, images } = articleImageSources(content);
  assertImageCount(images.length);
  const ossPrefix = ossArticleImagePrefix(articleId);
  if (!ossPrefix && images.length) {
    throw new ArticleImagePublicationError("OSS 公共访问地址配置不完整，请设置 OSS_BUCKET 或 OSS_PUBLIC_BASE_URL。", "configuration");
  }

  const localSources = new Map<string, { filename: string; targetUrl: string }>();
  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    if (isOssArticleImageSource(articleId, source)) continue;
    if (isRawLocalArticleImageSource(articleId, source)) {
      throw new ArticleImagePublicationError("正文仍引用原始导入图片；请先完成水印处理并替换为 /article-images/ 地址。", "validation");
    }
    if (!isProcessedLocalArticleImageSource(articleId, source)) {
      throw new ArticleImagePublicationError("正文仍有外链、Blob 或不属于当前文章的图片，请先处理后再发布。", "validation");
    }
    const filename = source.slice(`/article-images/${articleId}/`.length);
    if (!PROCESSED_FILENAME_PATTERN.test(filename)) {
      throw new ArticleImagePublicationError(`处理后图片文件名无效：${filename || source}`, "validation");
    }
    localSources.set(source, { filename, targetUrl: `${ossPrefix}${filename}` });
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

  for (const { filename } of localSources.values()) {
    const filePath = path.join(process.cwd(), "public", "article-images", articleId, filename);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new ArticleImagePublicationError(`找不到处理后的图片：${filename}`, "validation");
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      throw new ArticleImagePublicationError(`处理后的图片为空或超过 8 MB：${filename}`, "validation");
    }
    await uploadWithRetry(client, `${objectPrefix}/${articleId}/${filename}`, bytes, filename);
  }

  for (const image of images) {
    const source = $(image).attr("src")?.trim() || "";
    const replacement = localSources.get(source);
    if (replacement) $(image).attr("src", replacement.targetUrl);
  }
  const publishedContent = $.root().html() || content;
  assertArticleUsesOssImages(articleId, publishedContent);
  return { content: publishedContent, uploadedImageCount: localSources.size };
}
