import { createPrivateVideoAccessCode, listPrivateVideoAccessCodes } from "../../../../lib/private-video-access";
import { privateVideoBody, privateVideoFailure, privateVideoJSON, requirePrivateVideoAdmin } from "../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await requirePrivateVideoAdmin(request); return privateVideoJSON({ codes: listPrivateVideoAccessCodes() }); }
  catch (error) { return privateVideoFailure(error); }
}
export async function POST(request: Request) {
  try {
    await requirePrivateVideoAdmin(request, true);
    const body = await privateVideoBody(request);
    return privateVideoJSON(createPrivateVideoAccessCode(body.label ?? ""), 201);
  } catch (error) { return privateVideoFailure(error); }
}
