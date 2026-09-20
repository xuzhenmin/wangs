import { ensureArticleVideoShare, getArticleVideoShare, revokeArticleVideoShare } from "../../../../../../lib/article-video-share";
import { privateVideoBody, privateVideoFailure, privateVideoJSON, requirePrivateVideoAdmin } from "../../../../../../lib/private-video-http";
import { PrivateVideoError } from "../../../../../../lib/private-videos";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { await requirePrivateVideoAdmin(request); return privateVideoJSON(getArticleVideoShare((await context.params).id)); }
  catch (error) { return privateVideoFailure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    await requirePrivateVideoAdmin(request, true);
    const body = await privateVideoBody(request);
    if (body.action !== "ensure" && body.action !== "rotate") throw new PrivateVideoError("请指定创建/查看或重置文章分享链接。");
    return privateVideoJSON(ensureArticleVideoShare((await context.params).id, body.action));
  } catch (error) { return privateVideoFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { await requirePrivateVideoAdmin(request, true); return privateVideoJSON(revokeArticleVideoShare((await context.params).id)); }
  catch (error) { return privateVideoFailure(error); }
}
