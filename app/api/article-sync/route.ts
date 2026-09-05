import { load } from "cheerio";
import { storeArticleImageBytes, ImageLocalizationError } from "../../../lib/article-images";
import {
  ArticleSyncValidationError,
  MAX_SYNC_REQUEST_BYTES,
  type ArticleSyncManifestItem,
  validSyncedArticleId,
  verifyArticleSyncRequest,
} from "../../../lib/article-sync";
import {
  ExternalImagesPendingError,
  parseArticleInput,
  upsertSyncedArticle,
} from "../../../lib/articles";

const noStoreHeaders = { "Cache-Control": "no-store" };

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function positiveTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseManifest(value: FormDataEntryValue | null) {
  if (typeof value !== "string") throw new ArticleSyncValidationError("缺少图片清单。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ArticleSyncValidationError("图片清单格式无效。");
  }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new ArticleSyncValidationError("图片清单数量无效。");
  }
  const manifest = parsed as ArticleSyncManifestItem[];
  const sources = new Set<string>();
  const fields = new Set<string>();
  manifest.forEach((item, index) => {
    if (!item || typeof item.source !== "string" || item.field !== `image-${index}`
      || sources.has(item.source) || fields.has(item.field)) {
      throw new ArticleSyncValidationError("图片清单项目无效或重复。");
    }
    sources.add(item.source);
    fields.add(item.field);
  });
  return manifest;
}

function rewriteSyncedImages(articleId: string, content: string, replacements: Map<string, string>) {
  const allowedPrefixes = [
    `/uploads/articles/${articleId}/`,
    `/article-images/${articleId}/`,
  ];
  const $ = load(content, null, false);
  $("img").each((_index, element) => {
    const source = $(element).attr("src")?.trim() || "";
    if (!source.startsWith("/uploads/articles/") && !source.startsWith("/article-images/")) return;
    if (!allowedPrefixes.some((prefix) => source.startsWith(prefix))) {
      throw new ArticleSyncValidationError("正文包含不属于当前文章的本地图片。");
    }
    const replacement = replacements.get(source);
    if (!replacement) throw new ArticleSyncValidationError(`正文图片未包含在上传内容中：${source}`);
    $(element).attr("src", replacement);
  });
  return $.root().html() || content;
}

export async function POST(request: Request) {
  if (!verifyArticleSyncRequest(request)) return json({ error: "unauthorized" }, 401);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_REQUEST_BYTES) {
    return json({ error: "sync-request-too-large", detail: "单次同步内容不能超过 64 MB。" }, 413);
  }

  try {
    const form = await request.formData();
    const rawArticle = form.get("article");
    if (typeof rawArticle !== "string") throw new ArticleSyncValidationError("缺少文章数据。");
    let articleValue: unknown;
    try {
      articleValue = JSON.parse(rawArticle);
    } catch {
      throw new ArticleSyncValidationError("文章数据格式无效。");
    }
    if (!articleValue || typeof articleValue !== "object") throw new ArticleSyncValidationError("文章数据无效。");
    const raw = articleValue as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!validSyncedArticleId(id)) throw new ArticleSyncValidationError("文章 ID 无效。");
    const input = parseArticleInput({ ...raw, status: "published" });
    if (!input) throw new ArticleSyncValidationError("文章标题、摘要或正文无效。");

    const manifest = parseManifest(form.get("manifest"));
    const replacements = new Map<string, string>();
    for (const item of manifest) {
      const file = form.get(item.field);
      if (!(file instanceof File) || !file.size) {
        throw new ArticleSyncValidationError(`没有收到图片文件：${item.source}`);
      }
      const localUrl = await storeArticleImageBytes(id, new Uint8Array(await file.arrayBuffer()));
      replacements.set(item.source, localUrl);
    }

    const now = Date.now();
    const content = rewriteSyncedImages(id, input.content, replacements);
    const article = upsertSyncedArticle(id, { ...input, content, status: "published" }, {
      createdAt: positiveTimestamp(raw.createdAt, now),
      updatedAt: positiveTimestamp(raw.updatedAt, now),
    });
    return json({
      article,
      articlePath: `/articles/${article.id}`,
      uploadedImageCount: manifest.length,
    });
  } catch (error) {
    if (error instanceof ArticleSyncValidationError || error instanceof ImageLocalizationError || error instanceof ExternalImagesPendingError) {
      return json({ error: "invalid-article-sync", detail: error.message }, 422);
    }
    return json({ error: "article-sync-failed", detail: "远端保存文章失败。" }, 500);
  }
}
