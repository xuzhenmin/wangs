import { privateVideoPlayback } from "../../../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return privateVideoPlayback(request, (await context.params).id, "manifest", undefined, true);
}
