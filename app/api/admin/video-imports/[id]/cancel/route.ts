import { cancelVideoJob } from '../../../../../../lib/video-imports.mjs';
import { videoAdmin, videoFailure, videoJSON } from '../../../../../../lib/video-import-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = await videoAdmin(request, true); if (denied) return denied;
    const job = cancelVideoJob((await context.params).id);
    return videoJSON(job ? { job } : { error: '任务不存在。' }, job ? 200 : 404);
  } catch (error) { return videoFailure(error); }
}
