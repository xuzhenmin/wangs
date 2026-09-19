import { assertPrivateVideoSameOrigin, exchangePrivateVideoCode, privateVideoRequestAuthorized, privateVideoSessionCookie, revokePrivateVideoSession } from "../../../../lib/private-video-access";
import { privateVideoBody, privateVideoFailure, privateVideoJSON } from "../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return privateVideoJSON({ authorized: privateVideoRequestAuthorized(request) }); }
  catch (error) { return privateVideoFailure(error); }
}
export async function POST(request: Request) {
  try {
    assertPrivateVideoSameOrigin(request);
    const body = await privateVideoBody(request);
    const token = exchangePrivateVideoCode(request, body.code);
    return privateVideoJSON({ authorized: true }, 200, privateVideoSessionCookie(token, request));
  } catch (error) { return privateVideoFailure(error); }
}
export async function DELETE(request: Request) {
  try {
    assertPrivateVideoSameOrigin(request); revokePrivateVideoSession(request);
    return privateVideoJSON({ authorized: false }, 200, privateVideoSessionCookie("", request, true));
  } catch (error) { return privateVideoFailure(error); }
}
