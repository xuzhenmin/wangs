import { saveConsentedLocation } from "../../../lib/locations";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEBUG_LOCATION_LOGS = process.env.LOCATION_DEBUG_LOGS === "true";

function debugLocationLog(event: string, details: Record<string, unknown>) {
  if (!DEBUG_LOCATION_LOGS) return;
  console.info(`[location-server] ${event} ${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}`);
}

export async function POST(request: Request) {
  let requestId = crypto.randomUUID();
  try {
    const body = await request.json() as Record<string, unknown>;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy = Number(body.accuracy);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 100) : "";
    const city = typeof body.city === "string" ? body.city.trim().slice(0, 100) : "";
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 600) : "";
    const addressResolution = body.addressResolution && typeof body.addressResolution === "object"
      ? body.addressResolution as Record<string, unknown>
      : null;
    if (typeof addressResolution?.requestId === "string") requestId = addressResolution.requestId.slice(0, 100);
    debugLocationLog("request_received", {
      requestId,
      latitude,
      longitude,
      accuracy,
      city,
      address,
      addressResolution,
    });
    if (body.consent !== true || !deviceId || !city || !address || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      debugLocationLog("request_rejected", { requestId, reason: "invalid-location-consent" });
      return Response.json({ error: "invalid-location-consent" }, { status: 400 });
    }
    const now = Date.now();
    await saveConsentedLocation({
      id: crypto.randomUUID(),
      deviceId,
      city,
      address,
      latitude,
      longitude,
      accuracy: Math.max(0, Math.min(accuracy, 100000)),
      consentedAt: now,
      updatedAt: now,
      expiresAt: now + RETENTION_MS,
    });
    debugLocationLog("location_saved", {
      requestId,
      latitude,
      longitude,
      accuracy,
      city,
      address,
      expiresAt: now + RETENTION_MS,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    debugLocationLog("location_save_failed", {
      requestId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return Response.json({ error: "location-save-failed" }, { status: 500 });
  }
}
