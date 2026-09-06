import { verifyAdminRequest } from "../../../../lib/admin-auth";
import { ossArticleImageBaseUrl } from "../../../../lib/article-image-urls";
import { createArticle, ExternalImagesPendingError, listArticles, parseArticleInput } from "../../../../lib/articles";
import { ArticleImagePublicationError } from "../../../../lib/oss-article-images";

export async function GET(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return Response.json({
      articles: await listArticles(),
      articleImageBaseUrl: ossArticleImageBaseUrl(),
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
    if (error instanceof ArticleImagePublicationError) {
      const status = error.kind === "validation" ? 409 : error.kind === "configuration" ? 503 : 502;
      return Response.json({ error: `oss-image-${error.kind}`, detail: error.message }, { status, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof ExternalImagesPendingError) {
      return Response.json({ error: "external-images-pending", detail: error.message }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "article-create-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
