import { enqueueVideoOssUpload } from '../../../../../../lib/oss-videos';
import { videoAdmin, videoBody, videoFailure, videoJSON } from '../../../../../../lib/video-import-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = await videoAdmin(request, true); if (denied) return denied;
    const body = await videoBody(request);
    const authorized = body && typeof body === 'object' && 'authorized' in body ? body.authorized : false;
    const job = enqueueVideoOssUpload((await context.params).id, authorized);
    return videoJSON(job ? { job } : { error: '任务不存在。' }, job ? 202 : 404);
  } catch (error) { return videoFailure(error); }
}
