import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getVideoJob, videoFile } from '../../../../../../lib/video-imports.mjs';
import { videoAdmin, videoFailure, videoJSON } from '../../../../../../lib/video-import-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const denied = await videoAdmin(request); if (denied) return denied;
    const { id } = await context.params;
    const file = videoFile(id);
    if (!file) return videoJSON({ error: '视频尚未完成或不存在。' }, 404);
    const handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const headers = new Headers({ 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    if (new URL(request.url).searchParams.get('download') === '1') headers.set('Content-Disposition', `attachment; filename="video-${id}${getVideoJob(id)?.incomplete ? '-incomplete' : ''}.mp4"`);
    let start = 0, end = size - 1; const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size || (!match[1] && Number(match[2]) === 0)) {
        await handle.close(); headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    const stream = handle.createReadStream({ start, end, autoClose: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (error) { return videoFailure(error); }
}
