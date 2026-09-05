const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";

export class RevokedLocationConsentError extends Error {
  constructor() {
    super("位置授权已被管理员撤销，需要重新确认授权。");
    this.name = "RevokedLocationConsentError";
  }
}

export function clearStoredLocationConsent() {
  localStorage.removeItem("shenxiang_location");
  localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
  localStorage.removeItem(LOCATION_LAST_REFRESH_KEY);
}

export async function isStoredLocationConsentRevoked() {
  const deviceId = localStorage.getItem("shenxiang_device_id");
  if (!deviceId) return false;
  const response = await fetch("/api/location/consent-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`location-consent-status-http-${response.status}`);
  const result = await response.json() as { revoked?: unknown };
  return result.revoked === true;
}

export async function assertLocationUploadAccepted(response: Response) {
  if (response.ok) return;
  if (response.status === 409) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (result?.error === "location-consent-revoked") throw new RevokedLocationConsentError();
  }
  throw new Error(`location-upload-http-${response.status}`);
}
