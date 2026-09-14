import { getVideoJob } from '../../../../../lib/video-imports.mjs';
import { videoAdmin, videoFailure, videoJSON } from '../../../../../lib/video-import-http';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = await videoAdmin(request); if (denied) return denied;
    const job = getVideoJob((await context.params).id);
    return videoJSON(job ? { job } : { error: '任务不存在。' }, job ? 200 : 404);
  } catch (error) { return videoFailure(error); }
}
