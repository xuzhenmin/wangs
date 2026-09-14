import { consumePairing, createVideoJobs, validateBatch, validPairing } from '../../../lib/video-imports.mjs';
import { videoBody, videoFailure, videoJSON } from '../../../lib/video-import-http';
export const runtime = 'nodejs';
// Userscript cross-origin submission uses a short-lived, one-batch capability, never admin cookies.
export async function POST(request: Request) {
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (!validPairing(token)) return videoJSON({ error: '配对码无效、已使用或已过期，请在后台重新生成。' }, 401);
    const videos = validateBatch(await videoBody(request));
    // Check again after reading the body, consume before any asynchronous task creation.
    if (!validPairing(token)) return videoJSON({ error: '配对码已被使用，请重新生成。' }, 401);
    consumePairing(token);
    const jobs = await createVideoJobs(videos);
    return videoJSON({ jobs: jobs.map(job => ({ id: job.id, title: job.title })) }, 202);
  } catch (error) { return videoFailure(error); }
}
