import { coverResponse, getShareCover } from "../../../../lib/share-cover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return coverResponse(request, await getShareCover()); } catch {
    return new Response("Cover temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } });
  }
}
