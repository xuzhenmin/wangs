import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { ImageLocalizationError, localizeExternalArticleImages } from "../../../../../lib/article-images";
import { articleExists } from "../../../../../lib/articles";

const ARTICLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const body = await request.json() as { articleId?: unknown; content?: unknown };
    const articleId = typeof body.articleId === "string" ? body.articleId.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!ARTICLE_ID_PATTERN.test(articleId) || content.length > 200_000) {
      return Response.json({ error: "invalid-image-localization-request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (!articleExists(articleId)) {
      return Response.json({ error: "article-not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    const result = await localizeExternalArticleImages(articleId, content);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ImageLocalizationError) {
      return Response.json({ error: "image-localization-failed", detail: error.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "image-localization-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
