import { privateVideoPlayback } from "../../../../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await context.params;
  return privateVideoPlayback(request, id, "segment", index, true);
}
