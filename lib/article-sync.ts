import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type Article, saveOssContentForSync } from "./articles";
import { ArticleImagePublicationError, assertArticleUsesOssImages, publishProcessedArticleImagesToOss } from "./oss-article-images";

export const MAX_SYNC_REQUEST_BYTES = 512 * 1024;
const SYNC_TIMEOUT_MS = 3 * 60 * 1000;
const ARTICLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ArticleSyncResult = {
  status: "synced" | "failed";
  articleUrl?: string;
  detail?: string;
  uploadedImageCount?: number;
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
    if (article.status !== "published") {
      throw new ArticleSyncValidationError("只有本地已发布文章才能同步到远端。");
    }
    const endpoint = await remoteSyncEndpoint(remoteServer);
    const publication = await publishProcessedArticleImagesToOss(article.id, article.content);
    const preparedArticle = saveOssContentForSync(article, publication.content);
    if (!preparedArticle) throw new ArticleSyncValidationError("同步准备期间文章已被修改，请确认最新内容后重新同步。");
    assertArticleUsesOssImages(preparedArticle.id, preparedArticle.content);
    const payload = JSON.stringify({ article: preparedArticle });
    if (Buffer.byteLength(payload) > MAX_SYNC_REQUEST_BYTES) {
      throw new ArticleSyncValidationError("文章同步请求不能超过 512 KB。");
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "User-Agent": "Shenxiang-Article-Sync/1.0",
      },
      body: payload,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null) as null | { detail?: string };
    if (!response.ok) {
      const detail = data?.detail || `远端接口返回 HTTP ${response.status}。`;
      return { status: "failed", detail, uploadedImageCount: publication.uploadedImageCount };
    }
    return {
      status: "synced",
      articleUrl: new URL(`/articles/${article.id}`, endpoint).toString(),
      uploadedImageCount: publication.uploadedImageCount,
    };
  } catch (error) {
    const detail = error instanceof ArticleSyncValidationError || error instanceof ArticleImagePublicationError
      ? error.message
      : error instanceof Error && error.name === "TimeoutError"
        ? "远端同步超时。"
        : "无法连接远端同步接口；请确认地址是最终地址且不会发生 HTTP 跳转。";
    return { status: "failed", detail };
  }
}
