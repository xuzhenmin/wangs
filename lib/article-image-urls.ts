const ARTICLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_PREFIX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;

function normalizedObjectPrefix() {
  const configured = process.env.OSS_ARTICLE_IMAGE_PREFIX?.trim().replace(/^\/+|\/+$/g, "") || "article-images";
  return configured && configured.length <= 200 && OBJECT_PREFIX_PATTERN.test(configured)
    ? configured
    : null;
}

function normalizedPublicBaseUrl() {
  const configured = process.env.OSS_PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
      return url.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  const bucket = process.env.OSS_BUCKET?.trim();
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) return null;
  return `https://${bucket}.oss-accelerate.aliyuncs.com`;
}

export function ossArticleImageBaseUrl() {
  const publicBaseUrl = normalizedPublicBaseUrl();
  const objectPrefix = normalizedObjectPrefix();
  return publicBaseUrl && objectPrefix ? `${publicBaseUrl}/${objectPrefix}` : null;
}

export function ossArticleImagePrefix(articleId: string) {
  if (!ARTICLE_ID_PATTERN.test(articleId)) return null;
  const baseUrl = ossArticleImageBaseUrl();
  return baseUrl ? `${baseUrl}/${articleId}/` : null;
}

export function isOssArticleImageSource(articleId: string, source: string) {
  const prefix = ossArticleImagePrefix(articleId);
  if (!prefix || !source.startsWith(prefix)) return false;
  const filename = source.slice(prefix.length);
  return /^[0-9a-f]{24}\.(?:png|jpe?g|gif|webp)$/i.test(filename);
}

export function isRawLocalArticleImageSource(articleId: string, source: string) {
  return source.startsWith(`/uploads/articles/${articleId}/`);
}

export function isProcessedLocalArticleImageSource(articleId: string, source: string) {
  return source.startsWith(`/article-images/${articleId}/`);
}

export function isLegacyLocalArticleImageSource(articleId: string, source: string) {
  return isRawLocalArticleImageSource(articleId, source) || isProcessedLocalArticleImageSource(articleId, source);
}

export function isDisplayableArticleImageSource(articleId: string, source: string) {
  return isLegacyLocalArticleImageSource(articleId, source) || isOssArticleImageSource(articleId, source);
}

