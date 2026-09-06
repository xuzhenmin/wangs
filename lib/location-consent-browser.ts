const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";
const LOCATION_AUTHORIZED_AT_KEY = "shenxiang_location_authorized_at";
const LOCATION_CONSENT_TTL_MS = 100 * 24 * 60 * 60 * 1000;

export function getStoredLocationConsentExpiry() {
  const authorizedAt = Number(localStorage.getItem(LOCATION_AUTHORIZED_AT_KEY));
  if (Number.isFinite(authorizedAt) && authorizedAt > 0) return authorizedAt + LOCATION_CONSENT_TTL_MS;
  // Read existing installations' receipts without extending their original TTL.
  const savedLocation = localStorage.getItem("shenxiang_location");
  const expiry = Number(localStorage.getItem(LOCATION_CONSENT_EXPIRES_KEY));
  if (!savedLocation || !Number.isFinite(expiry) || expiry <= 0) return 0;
  try {
    const parsed = JSON.parse(savedLocation) as { consentedAt?: unknown };
    if (typeof parsed.consentedAt === "string") {
      const timestamp = Date.parse(parsed.consentedAt);
      if (Number.isFinite(timestamp)) return timestamp + LOCATION_CONSENT_TTL_MS;
    }
  } catch {
    return 0;
  }
  return expiry;
}

// Record the user's successful, explicit browser grant before address/network
// work. A failed upload must not erase consent or silently renew it on refresh.
export function rememberLocationConsent(expiresAt: number) {
  if (!localStorage.getItem("shenxiang_device_id")) localStorage.setItem("shenxiang_device_id", crypto.randomUUID());
  localStorage.setItem(LOCATION_AUTHORIZED_AT_KEY, String(expiresAt - LOCATION_CONSENT_TTL_MS));
  localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(expiresAt));
}

export const LOCATION_PERMISSION_DENIED_MESSAGE = "位置访问被拒绝，如需继续访问，请退出后重新打开网站。";

export class RevokedLocationConsentError extends Error {
  constructor() {
    super("位置授权已被管理员撤销，需要重新确认授权。");
    this.name = "RevokedLocationConsentError";
  }
}

export function clearStoredLocationConsent() {
  localStorage.removeItem(LOCATION_AUTHORIZED_AT_KEY);
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
