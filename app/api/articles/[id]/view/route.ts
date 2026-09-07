import { admitArticleView } from "../../../../../lib/article-access";
import { safeArticleContent } from "../../../../../lib/article-content";
import { articleVisitor } from "../../../../../lib/article-visitor";

const headers = { "Cache-Control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "cross-site-request" }, { status: 403, headers });
  let body;
  try { body = await request.json() as { eventId?: unknown } | null; } catch { /* Invalid JSON. */ }
  if (!body || typeof body.eventId !== "string" || !uuid.test(body.eventId)) return Response.json({ error: "invalid-view-event" }, { status: 400, headers });
  try {
    const { id } = await params;
    const visitor = articleVisitor(request);
    const result = admitArticleView(id, body.eventId, visitor.visitorKey);
    const responseHeaders = { ...headers, ...(visitor.cookie && (result.status === 200 || (result.status === 403 && visitor.visitorKey === null)) ? { "Set-Cookie": visitor.cookie } : {}) };
    if (result.status !== 200) return Response.json({ error: result.status === 404 ? "article-not-found" : result.status === 409 ? "view-event-conflict" : "article-access-restricted" }, { status: result.status, headers: responseHeaders });
    return Response.json({ content: safeArticleContent(id, result.content) }, { headers: responseHeaders });
  } catch {
    return Response.json({ error: "article-access-unavailable" }, { status: 503, headers });
  }
}
