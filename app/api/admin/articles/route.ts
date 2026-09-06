import { verifyAdminRequest } from "../../../../lib/admin-auth";
import { ossArticleImageBaseUrl } from "../../../../lib/article-image-urls";
import { createArticle, listArticles, parseArticleInput } from "../../../../lib/articles";

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
  } catch {
    return Response.json({ error: "article-create-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
