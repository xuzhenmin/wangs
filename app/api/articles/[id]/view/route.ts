import { recordArticleView } from "../../../../../lib/article-management";

const headers = { "Cache-Control": "no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "cross-site-request" }, { status: 403, headers });
  try {
    const { id } = await params;
    const body = await request.json() as { eventId?: unknown } | null;
    if (!body || typeof body.eventId !== "string" || !uuid.test(body.eventId)) return Response.json({ error: "invalid-view-event" }, { status: 400, headers });
    if (!recordArticleView(id, body.eventId)) return Response.json({ error: "article-not-found" }, { status: 404, headers });
    return new Response(null, { status: 204, headers });
  } catch {
    return Response.json({ error: "view-report-failed" }, { status: 400, headers });
  }
}
