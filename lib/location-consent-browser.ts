const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";

export const LOCATION_PERMISSION_DENIED_MESSAGE = "位置访问被拒绝。如需获取地址，可以退出当前页面后重新进入；若再次出现定位授权提示，请选择“允许”。如果没有再次弹出提示，请在浏览器的网站设置中将“位置”改为“询问”或“允许”，并检查系统定位权限。";

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
