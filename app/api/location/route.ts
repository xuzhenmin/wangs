import { saveConsentedLocation } from "../../../lib/locations";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy = Number(body.accuracy);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 100) : "";
    const city = typeof body.city === "string" ? body.city.trim().slice(0, 100) : "";
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 600) : "";
    if (body.consent !== true || !deviceId || !city || !address || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
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
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "location-save-failed" }, { status: 500 });
  }
}
