import { articleVideoViewerCookie, exchangeArticleVideoShare, requestAuthorizedForArticle, revokeArticleVideoViewerGrant } from "../../../../../lib/article-video-share";
import { assertPrivateVideoSameOrigin } from "../../../../../lib/private-video-access";
import { privateVideoBody, privateVideoFailure, privateVideoJSON } from "../../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try { return privateVideoJSON({ authorized: requestAuthorizedForArticle(request, (await context.params).id) }); }
  catch (error) { return privateVideoFailure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertPrivateVideoSameOrigin(request);
    const body = await privateVideoBody(request);
    const token = exchangeArticleVideoShare(request, (await context.params).id, body.code);
    return privateVideoJSON({ authorized: true }, 200, articleVideoViewerCookie(token, request));
  } catch (error) { return privateVideoFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertPrivateVideoSameOrigin(request);
    revokeArticleVideoViewerGrant(request, (await context.params).id);
    return privateVideoJSON({ authorized: false });
  } catch (error) { return privateVideoFailure(error); }
}
