import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { load } from "cheerio";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_ARTICLE = 50;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 15_000;

export class ImageLocalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageLocalizationError";
  }
}

export function hasPendingArticleImages(html: string) {
  const $ = load(html, null, false);
  return $("img").toArray().some((element) => {
    const src = $(element).attr("src")?.trim() || "";
    return /^(?:https?:\/\/|blob:)/i.test(src);
  });
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff");
  }
  return true;
}

async function assertPublicImageUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageLocalizationError("图片地址格式无效。");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new ImageLocalizationError("图片地址必须是公开的 HTTP 或 HTTPS 地址。");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new ImageLocalizationError("不能下载本机或内网图片地址。");
  }
  let addresses: Awaited<ReturnType<typeof lookup>>[] | { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ImageLocalizationError(`无法解析图片域名：${hostname}`);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ImageLocalizationError("不能下载解析到本机或内网的图片地址。");
  }
  return url;
}

async function fetchImageResponse(source: string) {
  let url = await assertPublicImageUrl(source);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1",
          "User-Agent": "Shenxiang-Article-Image-Importer/1.0",
        },
      });
    } catch {
      throw new ImageLocalizationError(`图片下载失败或超时：${url.hostname}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) throw new ImageLocalizationError("图片重定向次数过多。");
      url = await assertPublicImageUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new ImageLocalizationError(`图片服务器返回 ${response.status}。`);
    return response;
  }
  throw new ImageLocalizationError("图片下载失败。");
}

function detectedImageExtension(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "webp";
  return null;
}

export async function storeArticleImageBytes(articleId: string, input: Uint8Array) {
  if (input.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageLocalizationError("单张图片不能超过 8 MB。");
  }
  const bytes = Buffer.from(input);
  const extension = detectedImageExtension(bytes);
  if (!extension) throw new ImageLocalizationError("图片文件内容无法识别，仅支持 PNG、JPEG、GIF 和 WebP。");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
  const relativeDirectory = path.posix.join("uploads", "articles", articleId);
  const filename = `${digest}.${extension}`;
  const targetDirectory = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "uploads",
    "articles",
    articleId,
  );
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(path.join(targetDirectory, filename), bytes);
  return `/${relativeDirectory}/${filename}`;
}

async function readImageBytes(response: Response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    throw new ImageLocalizationError("外链返回的不是受支持的位图图片。");
  }
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_IMAGE_BYTES) {
    throw new ImageLocalizationError("单张图片不能超过 8 MB。");
  }
  if (!response.body) throw new ImageLocalizationError("图片响应没有可读取的内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new ImageLocalizationError("单张图片不能超过 8 MB。");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  const extension = detectedImageExtension(bytes);
  if (!extension) throw new ImageLocalizationError("图片文件内容无法识别，仅支持 PNG、JPEG、GIF 和 WebP。");
  return { bytes, extension };
}

async function downloadImage(articleId: string, source: string) {
  const response = await fetchImageResponse(source);
  const { bytes } = await readImageBytes(response);
  return storeArticleImageBytes(articleId, bytes);
}

export async function localizeExternalArticleImages(articleId: string, html: string) {
  const $ = load(html, null, false);
  const externalImages = $("img").toArray().filter((element) => {
    const src = $(element).attr("src")?.trim() || "";
    return /^https?:\/\//i.test(src);
  });
  if (externalImages.length > MAX_IMAGES_PER_ARTICLE) {
    throw new ImageLocalizationError(`每篇文章最多可下载 ${MAX_IMAGES_PER_ARTICLE} 张外链图片。`);
  }
  const downloaded = new Map<string, string>();
  for (const element of externalImages) {
    const source = $(element).attr("src")!.trim();
    let localPath = downloaded.get(source);
    if (!localPath) {
      localPath = await downloadImage(articleId, source);
      downloaded.set(source, localPath);
    }
    $(element).attr("src", localPath);
  }
  return { content: $.root().html() || html, localizedImageCount: downloaded.size };
}
