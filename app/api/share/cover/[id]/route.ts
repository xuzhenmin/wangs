import { getPublishedArticle } from "../../../../../lib/articles";
import { ARTICLE_UUID } from "../../../../../lib/share-metadata";
import { coverResponse, getShareCover } from "../../../../../lib/share-cover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const article = ARTICLE_UUID.test(id) ? await getPublishedArticle(id) : undefined;
  if (!article) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  try { return coverResponse(request, await getShareCover(article)); } catch {
    return new Response("Cover temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } });
  }
}
