import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { createImageImportTask } from "../../../../../lib/image-import";

const ARTICLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const body = await request.json() as { articleId?: unknown };
    const articleId = typeof body.articleId === "string" ? body.articleId.trim() : "";
    if (!ARTICLE_ID_PATTERN.test(articleId)) {
      return Response.json({ error: "invalid-article-id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const task = createImageImportTask(articleId);
    if (!task) return Response.json({ error: "article-not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json({ task }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "image-import-task-create-failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
