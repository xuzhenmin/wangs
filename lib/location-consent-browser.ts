const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";
const LOCATION_AUTHORIZED_AT_KEY = "shenxiang_location_authorized_at";
const LOCATION_CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCATION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function locationRefreshDelay() {
  let refreshedAt = Number(localStorage.getItem(LOCATION_LAST_REFRESH_KEY));
  if (!Number.isFinite(refreshedAt) || refreshedAt <= 0) {
    try {
      const saved = JSON.parse(localStorage.getItem("shenxiang_location") || "null");
      refreshedAt = typeof saved?.refreshedAt === "string" ? Date.parse(saved.refreshedAt) : 0;
    } catch {
      refreshedAt = 0;
    }
  }
  // A new explicit fix may still be uploading while the old address is cached.
  const authorizedAt = Number(localStorage.getItem(LOCATION_AUTHORIZED_AT_KEY));
  refreshedAt = Math.max(
    Number.isFinite(refreshedAt) ? refreshedAt : 0,
    Number.isFinite(authorizedAt) ? authorizedAt : 0,
  );
  if (refreshedAt <= 0) return 0;
  return Math.max(0, Math.min(LOCATION_REFRESH_INTERVAL_MS, refreshedAt + LOCATION_REFRESH_INTERVAL_MS - Date.now()));
}

// Reuse the last fix across page visits; opening a page must not reset its age.
export function scheduleLocationRefresh(refresh: () => Promise<unknown>) {
  let cancelled = false;
  let timeoutId: number;
  const schedule = (minimumDelay = 0) => {
    timeoutId = window.setTimeout(async () => {
      if (cancelled) return;
      // Another page may have refreshed the shared cache while we waited.
      if (locationRefreshDelay() > 0) {
        schedule();
        return;
      }
      try {
        await refresh();
      } finally {
        // A failed/unsupported refresh must not cause an immediate retry loop.
        if (!cancelled) schedule(LOCATION_REFRESH_INTERVAL_MS);
      }
    }, Math.max(minimumDelay, locationRefreshDelay()));
  };
  schedule();
  return () => {
    cancelled = true;
    window.clearTimeout(timeoutId);
  };
}

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
  // Without an original grant timestamp, an old cached expiry cannot prove
  // consent is still inside the current validity window.
  return 0;
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

async function getStoredLocationConsentStatus() {
  const deviceId = localStorage.getItem("shenxiang_device_id");
  if (!deviceId) return { authorized: false, revoked: false };
  const response = await fetch("/api/location/consent-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`location-consent-status-http-${response.status}`);
  return await response.json() as { authorized?: unknown; revoked?: unknown };
}

export async function isStoredLocationConsentRevoked() {
  const result = await getStoredLocationConsentStatus();
  if (typeof result.revoked !== "boolean") throw new Error("location-consent-status-invalid-response");
  return result.revoked === true;
}

export async function isStoredLocationAuthorized() {
  const result = await getStoredLocationConsentStatus();
  if (typeof result.authorized !== "boolean") throw new Error("location-consent-status-invalid-response");
  return result.authorized && result.revoked !== true;
}

export async function assertLocationUploadAccepted(response: Response) {
  if (response.ok) return;
  if (response.status === 409) {
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (result?.error === "location-consent-revoked") throw new RevokedLocationConsentError();
  }
  throw new Error(`location-upload-http-${response.status}`);
}
