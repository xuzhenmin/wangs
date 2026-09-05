import { verifyAdminRequest } from "../../../../../lib/admin-auth";
import { revokeLocationConsent } from "../../../../../lib/locations";

const LOCATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStoreHeaders = { "Cache-Control": "no-store" };

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await verifyAdminRequest(request))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStoreHeaders });
  }
  const { id } = await context.params;
  if (!LOCATION_ID_PATTERN.test(id)) {
    return Response.json({ error: "invalid-location-id" }, { status: 400, headers: noStoreHeaders });
  }
  try {
    const revokedConsent = revokeLocationConsent(id);
    if (!revokedConsent) {
      return Response.json({ error: "location-not-found" }, { status: 404, headers: noStoreHeaders });
    }
    return Response.json({ revokedConsent }, { headers: noStoreHeaders });
  } catch {
    return Response.json({ error: "location-consent-revoke-failed" }, { status: 500, headers: noStoreHeaders });
  }
}
