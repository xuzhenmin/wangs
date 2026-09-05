import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { load } from "cheerio";
import type { Article } from "./articles";

const MAX_SYNC_IMAGES = 20;
const MAX_SYNC_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_REQUEST_BYTES = 64 * 1024 * 1024;
const SYNC_TIMEOUT_MS = 3 * 60 * 1000;
const ARTICLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ArticleSyncResult = {
  status: "synced" | "failed";
  articleUrl?: string;
  uploadedImageCount?: number;
  detail?: string;
};

export type ArticleSyncManifestItem = {
  source: string;
  field: string;
};

export class ArticleSyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleSyncValidationError";
  }
}

function syncSecret() {
  return process.env.ARTICLE_SYNC_SECRET?.trim() || "";
}

export function verifyArticleSyncRequest(request: Request) {
  const expectedSecret = syncSecret();
  if (expectedSecret.length < 32) return false;
  const authorization = request.headers.get("authorization") || "";
  const candidateSecret = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const actual = Buffer.from(candidateSecret);
  const expected = Buffer.from(expectedSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validSyncedArticleId(id: string) {
  return ARTICLE_ID_PATTERN.test(id);
}

function managedImagePrefix(articleId: string) {
  return [
    `/uploads/articles/${articleId}/`,
    `/article-images/${articleId}/`,
  ];
}

function isManagedArticleImage(source: string) {
  return source.startsWith("/uploads/articles/") || source.startsWith("/article-images/");
}

function articleImageSources(article: Article) {
  const allowedPrefixes = managedImagePrefix(article.id);
  const $ = load(article.content, null, false);
  const sources = new Set<string>();
  $("img").each((_index, element) => {
    const source = $(element).attr("src")?.trim() || "";
    if (!source || !isManagedArticleImage(source)) return;
    if (!allowedPrefixes.some((prefix) => source.startsWith(prefix))) {
      throw new ArticleSyncValidationError("正文包含不属于当前文章的本地图片。");
    }
    sources.add(source);
  });
  if (sources.size > MAX_SYNC_IMAGES) {
    throw new ArticleSyncValidationError(`每篇文章最多同步 ${MAX_SYNC_IMAGES} 张图片。`);
  }
  return [...sources];
}

function imageContentType(filename: string) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function localImageFile(source: string) {
  if (source.includes("?") || source.includes("#") || source.includes("\\")) {
    throw new ArticleSyncValidationError(`本地图片地址无效：${source}`);
  }
  const publicDirectory = path.resolve(process.cwd(), "public");
  const filename = path.resolve(publicDirectory, source.slice(1));
  if (!filename.startsWith(`${publicDirectory}${path.sep}`)) {
    throw new ArticleSyncValidationError("图片路径超出 public 目录。");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filename);
  } catch {
    throw new ArticleSyncValidationError(`找不到正文图片：${source}`);
  }
  if (!bytes.length || bytes.length > MAX_SYNC_IMAGE_BYTES) {
    throw new ArticleSyncValidationError(`图片为空或超过 8 MB：${source}`);
  }
  return { bytes, filename };
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

async function remoteSyncEndpoint(value: string) {
  const configured = value.trim();
  if (!configured || configured.length > 500) {
    throw new ArticleSyncValidationError("请输入远端服务器网址或公网 IP。");
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured);
  const isIpv4Input = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(configured);
  let endpoint: URL;
  try {
    endpoint = new URL(hasScheme ? configured : `${isIpv4Input ? "http" : "https"}://${configured}`);
  } catch {
    throw new ArticleSyncValidationError("远端服务器地址格式无效。");
  }
  if (!(["http:", "https:"] as string[]).includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new ArticleSyncValidationError("远端同步地址必须是 HTTP 或 HTTPS URL。");
  }
  if (endpoint.search || endpoint.hash) throw new ArticleSyncValidationError("远端同步地址不能包含查询参数或锚点。");
  const pathname = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = !pathname || pathname === "/"
    ? "/api/article-sync"
    : pathname.endsWith("/api/article-sync") ? pathname : `${pathname}/api/article-sync`;

  const hostname = endpoint.hostname.toLowerCase();
  const allowPrivateAddress = process.env.ARTICLE_SYNC_ALLOW_PRIVATE === "true";
  if (!allowPrivateAddress && (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal"))) {
    throw new ArticleSyncValidationError("远端同步地址不能是本机或内网地址。");
  }
  let addresses: { address: string }[];
  try {
    addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ArticleSyncValidationError(`无法解析远端服务器域名：${hostname}`);
  }
  if (!addresses.length || (!allowPrivateAddress && addresses.some(({ address }) => isPrivateAddress(address)))) {
    throw new ArticleSyncValidationError("远端同步地址不能解析到本机或内网 IP。");
  }
  return endpoint;
}

export async function syncArticleToRemote(article: Article, remoteServer: string): Promise<ArticleSyncResult> {
  const secret = syncSecret();
  if (secret.length < 32) return { status: "failed", detail: "ARTICLE_SYNC_SECRET 必须至少包含 32 个字符。" };

  try {
    const endpoint = await remoteSyncEndpoint(remoteServer);
    const sources = articleImageSources(article);
    const form = new FormData();
    form.set("article", JSON.stringify(article));
    const manifest: ArticleSyncManifestItem[] = [];
    for (const [index, source] of sources.entries()) {
      const { bytes, filename } = await localImageFile(source);
      const field = `image-${index}`;
      manifest.push({ source, field });
      const fileBytes = new Uint8Array(bytes.byteLength);
      fileBytes.set(bytes);
      form.set(field, new File([fileBytes], path.basename(filename), { type: imageContentType(filename) }));
    }
    form.set("manifest", JSON.stringify(manifest));

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "User-Agent": "Shenxiang-Article-Sync/1.0",
      },
      body: form,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null) as null | {
      detail?: string;
      uploadedImageCount?: number;
    };
    if (!response.ok) {
      const detail = data?.detail || (response.status === 413
        ? "远端代理拒绝了上传体积，请提高 Nginx client_max_body_size。"
        : `远端接口返回 HTTP ${response.status}。`);
      return { status: "failed", detail };
    }
    return {
      status: "synced",
      articleUrl: new URL(`/articles/${article.id}`, endpoint).toString(),
      uploadedImageCount: data?.uploadedImageCount || 0,
    };
  } catch (error) {
    const detail = error instanceof ArticleSyncValidationError
      ? error.message
      : error instanceof Error && error.name === "TimeoutError"
        ? "远端同步超时。"
        : "无法连接远端同步接口；请确认地址是最终地址且不会发生 HTTP 跳转。";
    return { status: "failed", detail };
  }
}
