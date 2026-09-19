import { revokePrivateVideoAccessCode } from "../../../../../lib/private-video-access";
import { privateVideoFailure, privateVideoJSON, requirePrivateVideoAdmin } from "../../../../../lib/private-video-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrivateVideoAdmin(request, true);
    revokePrivateVideoAccessCode((await context.params).id);
    return privateVideoJSON({ revoked: true });
  } catch (error) { return privateVideoFailure(error); }
}
