import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { parseArticleInput, updateArticle } from "../../../../../lib/articles";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const input = parseArticleInput(await request.json());
    if (!input) return Response.json({ error: "invalid-article" }, { status: 400 });
    const { id } = await context.params;
    const result = await updateArticle(id, input);
    if (!result) return Response.json({ error: "article-not-found" }, { status: 404 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "article-update-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
