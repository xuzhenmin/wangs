import { createPairing } from '../../../../../lib/video-imports.mjs';
import { videoAdmin, videoFailure, videoJSON } from '../../../../../lib/video-import-http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const denied = await videoAdmin(request, true); if (denied) return denied;
    return videoJSON(createPairing(), 201);
  } catch (error) { return videoFailure(error); }
}
