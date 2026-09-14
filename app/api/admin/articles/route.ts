import { verifyAdminRequest } from "../../../../lib/admin-auth";
import { ossArticleImageBaseUrl } from "../../../../lib/article-image-urls";
import { ossArticleVideoBaseUrl } from "../../../../lib/article-video-urls";
import { ArticleVideoValidationError } from "../../../../lib/article-videos";
import { createArticle, listArticles, parseArticleInput } from "../../../../lib/articles";

export async function GET(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return Response.json({
      articles: await listArticles(),
      articleImageBaseUrl: ossArticleImageBaseUrl(),
      articleVideoBaseUrl: ossArticleVideoBaseUrl(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "article-read-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const input = parseArticleInput(await request.json());
    if (!input) return Response.json({ error: "invalid-article" }, { status: 400 });
    return Response.json(await createArticle(input), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ArticleVideoValidationError) return Response.json({ error: "invalid-article-video", detail: error.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: "article-create-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
