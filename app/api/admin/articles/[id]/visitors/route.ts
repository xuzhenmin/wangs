import { verifyAdminRequest } from "../../../../../../lib/admin-auth";
import { listArticleVisitors } from "../../../../../../lib/article-management";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await verifyAdminRequest(request))) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const { id } = await params;
    const result = listArticleVisitors(id, new URL(request.url).searchParams.get("page"));
    if (!result) return Response.json({ error: "article-not-found" }, { status: 404, headers });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "visitor-list-unavailable" }, { status: 500, headers });
  }
}
