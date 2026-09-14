import { verifyAdminRequest } from './admin-auth';
import { VideoError } from './video-download.mjs';

export function videoJSON(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function videoAdmin(request: Request, mutation = false) {
  if (!(await verifyAdminRequest(request))) return videoJSON({ error: '请先登录超级管理员。' }, 401);
  if (mutation) {
    let sameOrigin = false;
    try {
      const origin = new URL(request.headers.get('origin') || '');
      // Next may use an internal hostname in request.url; Host preserves the browser-facing host/port.
      sameOrigin = ['http:', 'https:'].includes(origin.protocol) && origin.host === request.headers.get('host') && request.headers.get('sec-fetch-site') !== 'cross-site';
    } catch { /* Missing or malformed Origin must not authorize a write. */ }
    if (!sameOrigin) return videoJSON({ error: '仅允许从本站管理页面操作。' }, 403);
  }
  return null;
}
export function videoFailure(error: unknown) {
  return videoJSON({ error: error instanceof VideoError ? error.message : '视频任务服务暂时不可用，请检查本地磁盘和服务状态。' }, error instanceof VideoError ? 422 : 500);
}
export async function videoBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new VideoError('请求必须使用 JSON。');
  if (Number(request.headers.get('content-length')) > 64000) throw new VideoError('请求内容过大。');
  const reader = request.body?.getReader();
  if (!reader) throw new VideoError('请求内容为空。');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length;
      if (size > 64000) { await reader.cancel(); throw new VideoError('请求内容过大。'); }
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) { if (error instanceof VideoError) throw error; throw new VideoError('JSON 请求格式无效。'); }
  finally { reader.releaseLock(); }
}
