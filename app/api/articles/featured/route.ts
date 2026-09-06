import { randomPublishedHeadlines } from "../../../../lib/articles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return Response.json({ articles: randomPublishedHeadlines() }, { headers });
  } catch {
    return Response.json({ error: "headlines-unavailable" }, { status: 503, headers });
  }
}
