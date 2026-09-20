import { assertPrivateVideoSameOrigin, exchangePrivateVideoCode, matchesPrivateVideoAccessCode, privateVideoRequestAuthorized, privateVideoRequestAuthorizedForAsset, privateVideoSessionCookie, revokePrivateVideoSession } from "../../../../lib/private-video-access";
import { privateVideoBody, privateVideoFailure, privateVideoJSON } from "../../../../lib/private-video-http";
import { articleHasPrivateVideos, articleVideoViewerCookie, exchangeArticleVideoShare, revokeArticleVideoViewerSession } from "../../../../lib/article-video-share";
import { PrivateVideoError } from "../../../../lib/private-videos";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const authorized = query.has("assetId") ? privateVideoRequestAuthorizedForAsset(request, query.get("assetId") || "") : privateVideoRequestAuthorized(request);
    return privateVideoJSON({ authorized });
  }
  catch (error) { return privateVideoFailure(error); }
}
export async function POST(request: Request) {
  try {
    assertPrivateVideoSameOrigin(request);
    const body = await privateVideoBody(request);
    if (body.articleId !== undefined) {
      if (typeof body.articleId !== "string" || !articleHasPrivateVideos(body.articleId)) throw new PrivateVideoError("当前文章没有已就绪的私密视频，或尚未发布。", 422);
      if (!matchesPrivateVideoAccessCode(body.code)) {
        const token = exchangeArticleVideoShare(request, body.articleId, body.code);
        return privateVideoJSON({ authorized: true }, 200, articleVideoViewerCookie(token, request));
      }
    }
    const token = exchangePrivateVideoCode(request, body.code);
    return privateVideoJSON({ authorized: true }, 200, privateVideoSessionCookie(token, request));
  } catch (error) { return privateVideoFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    assertPrivateVideoSameOrigin(request); revokePrivateVideoSession(request);
    revokeArticleVideoViewerSession(request);
    return privateVideoJSON({ authorized: false }, 200, [privateVideoSessionCookie("", request, true), articleVideoViewerCookie("", request, true)]);
  } catch (error) { return privateVideoFailure(error); }
}
