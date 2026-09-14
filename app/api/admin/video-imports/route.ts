import { createVideoJobs, listVideoJobs, toolsStatus, validateBatch } from '../../../../lib/video-imports.mjs';
import { videoAdmin, videoBody, videoFailure, videoJSON } from '../../../../lib/video-import-http';
import { videoOssStatus } from '../../../../lib/oss-videos';
import { ossArticleVideoBaseUrl } from '../../../../lib/article-video-urls';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const denied = await videoAdmin(request); if (denied) return denied;
    return videoJSON({ jobs: listVideoJobs(), tools: await toolsStatus(), oss: videoOssStatus(), articleVideoBaseUrl: ossArticleVideoBaseUrl() });
  } catch (error) { return videoFailure(error); }
}
export async function POST(request: Request) {
  try {
    const denied = await videoAdmin(request, true); if (denied) return denied;
    const videos = validateBatch(await videoBody(request));
    return videoJSON({ jobs: await createVideoJobs(videos) }, 202);
  } catch (error) { return videoFailure(error); }
}
