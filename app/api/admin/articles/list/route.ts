import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { listManagedArticles } from "../../../../../lib/article-management";

const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  if (!(await verifyAdminRequest(request))) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    return Response.json(listManagedArticles(new URL(request.url).searchParams), { headers });
  } catch {
    return Response.json({ error: "article-list-unavailable" }, { status: 500, headers });
  }
}
