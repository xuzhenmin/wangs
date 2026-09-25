import { confirmVideoTail, discardVideoTail } from '../../../../../../lib/video-imports.mjs';
import { VideoError } from '../../../../../../lib/video-download.mjs';
import { videoAdmin, videoBody, videoFailure, videoJSON } from '../../../../../../lib/video-import-http';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = await videoAdmin(request, true); if (denied) return denied;
    const body = await videoBody(request) as { action?: unknown; confirmed?: unknown } | null;
    if (!body || body.confirmed !== true || !['merge', 'discard'].includes(String(body.action))) throw new VideoError('请明确确认忽略尾段合成或丢弃保留分片。');
    const { id } = await context.params;
    const job = body.action === 'merge' ? confirmVideoTail(id) : await discardVideoTail(id);
    return videoJSON({ job }, body.action === 'merge' ? 202 : 200);
  } catch (error) { return videoFailure(error); }
}
