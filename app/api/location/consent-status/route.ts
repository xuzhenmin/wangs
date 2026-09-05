import { isLocationConsentRevoked } from "../../../../lib/locations";

const noStoreHeaders = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const body = await request.json() as { deviceId?: unknown };
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 100) {
      return Response.json({ error: "invalid-device-id" }, { status: 400, headers: noStoreHeaders });
    }
    return Response.json({ revoked: isLocationConsentRevoked(deviceId) }, { headers: noStoreHeaders });
  } catch {
    return Response.json({ error: "consent-status-unavailable" }, { status: 500, headers: noStoreHeaders });
  }
}
