import { verifyAdminRequest } from "../../../../../../lib/admin-auth";
import { getArticleAccess, parseArticleAccessInput, setArticleAccess } from "../../../../../../lib/article-access";

const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  if (!(await verifyAdminRequest(request))) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const result = getArticleAccess((await params).id);
    return result ? Response.json(result, { headers }) : Response.json({ error: "article-not-found" }, { status: 404, headers });
  } catch {
    return Response.json({ error: "access-settings-unavailable" }, { status: 503, headers });
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "cross-site-request" }, { status: 403, headers });
  if (!(await verifyAdminRequest(request))) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  let input;
  try { input = parseArticleAccessInput(await request.json()); } catch { /* Invalid JSON. */ }
  if (!input) return Response.json({ error: "invalid-access-settings" }, { status: 400, headers });
  try {
    const result = setArticleAccess((await params).id, input);
    if (result.status !== 200) return Response.json({ error: result.status === 409 ? "access-settings-changed" : "article-not-found" }, { status: result.status, headers });
    return Response.json(result.result, { headers });
  } catch {
    return Response.json({ error: "access-settings-save-failed" }, { status: 503, headers });
  }
}
