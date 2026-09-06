import {
  ArticleSyncValidationError,
  MAX_SYNC_REQUEST_BYTES,
  validSyncedArticleId,
  verifyArticleSyncRequest,
} from "../../../lib/article-sync";
import {
  ExternalImagesPendingError,
  parseArticleInput,
  upsertSyncedArticle,
} from "../../../lib/articles";
import { ArticleImagePublicationError } from "../../../lib/oss-article-images";

const noStoreHeaders = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function positiveTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function POST(request: Request) {
  if (!verifyArticleSyncRequest(request)) return json({ error: "unauthorized" }, 401);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_REQUEST_BYTES) {
    return json({ error: "sync-request-too-large", detail: "文章同步请求不能超过 512 KB。" }, 413);
  }

  try {
    const payload = await request.json() as { article?: unknown };
    if (!payload.article || typeof payload.article !== "object") {
      throw new ArticleSyncValidationError("缺少文章数据。");
    }
    const raw = payload.article as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!validSyncedArticleId(id)) throw new ArticleSyncValidationError("文章 ID 无效。");
    const input = parseArticleInput({ ...raw, status: "published" });
    if (!input) throw new ArticleSyncValidationError("文章标题、摘要或正文无效。");

    const now = Date.now();
    const article = upsertSyncedArticle(id, input, {
      createdAt: positiveTimestamp(raw.createdAt, now),
      updatedAt: positiveTimestamp(raw.updatedAt, now),
    });
    return json({ article, articlePath: `/articles/${article.id}` });
  } catch (error) {
    if (error instanceof ArticleSyncValidationError
      || error instanceof ArticleImagePublicationError
      || error instanceof ExternalImagesPendingError) {
      return json({ error: "invalid-article-sync", detail: error.message }, 422);
    }
    return json({ error: "article-sync-failed", detail: "远端保存文章失败。" }, 500);
  }
}
