"use client";

import { useEffect, useState } from "react";

type ReverseAddress = {
  display_name?: string;
  address?: Record<string, string>;
};

type AddressResolutionDiagnostics = {
  requestId: string;
  status: "success" | "failed";
  durationMs: number;
  httpStatus?: number;
  error?: string;
};

const LOCATION_CONSENT_TTL_MS = 30 * 60 * 1000;
const LOCATION_PROMPT_DELAY_MS = 1500;
const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";

function locationLog(event: string, details: Record<string, unknown> = {}) {
  console.info(`[location] ${event}`, { timestamp: new Date().toISOString(), ...details });
}

function errorDescription(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function clearStoredLocation() {
  localStorage.removeItem("shenxiang_location");
  localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
  localStorage.removeItem(LOCATION_LAST_REFRESH_KEY);
}

function getStoredConsentExpiry() {
  const savedLocation = localStorage.getItem("shenxiang_location");
  const savedExpiry = Number(localStorage.getItem(LOCATION_CONSENT_EXPIRES_KEY));
  if (!savedLocation || !Number.isFinite(savedExpiry)) return 0;

  try {
    const parsed = JSON.parse(savedLocation) as { consentedAt?: unknown };
    if (typeof parsed.consentedAt === "string") {
      const consentedAt = Date.parse(parsed.consentedAt);
      if (Number.isFinite(consentedAt)) return Math.min(savedExpiry, consentedAt + LOCATION_CONSENT_TTL_MS);
    }
  } catch {
    return 0;
  }

  return savedExpiry;
}

export default function ArticleLocationGate() {
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const [consentExpiresAt, setConsentExpiresAt] = useState(0);

  useEffect(() => {
    let promptTimeoutId: number | undefined;
    let activationTimeoutId: number | undefined;
    const storedExpiry = getStoredConsentExpiry();
    const remaining = storedExpiry - Date.now();

    if (remaining > 0) {
      localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(storedExpiry));
      activationTimeoutId = window.setTimeout(() => setConsentExpiresAt(storedExpiry), 0);
    } else {
      clearStoredLocation();
      promptTimeoutId = window.setTimeout(() => setOpen(true), LOCATION_PROMPT_DELAY_MS);
    }

    return () => {
      if (promptTimeoutId !== undefined) window.clearTimeout(promptTimeoutId);
      if (activationTimeoutId !== undefined) window.clearTimeout(activationTimeoutId);
    };
  }, []);

  useEffect(() => {
    if (!consentExpiresAt) return;
    const remaining = consentExpiresAt - Date.now();
    const expireConsent = () => {
      clearStoredLocation();
      setConsentExpiresAt(0);
      setOpen(true);
    };
    if (remaining <= 0) {
      expireConsent();
      return;
    }
    const expiryTimeoutId = window.setTimeout(expireConsent, remaining);
    return () => window.clearTimeout(expiryTimeoutId);
  }, [consentExpiresAt]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const requestLocation = () => {
    setError("");
    if (!navigator.geolocation) {
      setError("当前浏览器不支持定位，无法继续查看内容。");
      return;
    }

    setRequesting(true);
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "article", timeoutMs: 12000, hardTimeoutMs: 15000 });
    let requestActive = true;
    const hardTimeoutId = window.setTimeout(() => {
      requestActive = false;
      setRequesting(false);
      setError("定位请求超时，请检查浏览器定位权限后重试。");
      locationLog("geolocation_hard_timeout", { requestId, mode: "article", durationMs: Math.round(performance.now() - locationStartedAt) });
    }, 15000);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        const { latitude, longitude, accuracy } = position.coords;
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        let city = "未知城市";
        let address = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        const reverseStartedAt = performance.now();
        let addressResolution: AddressResolutionDiagnostics;

        locationLog("geolocation_succeeded", {
          requestId,
          mode: "article",
          latitude,
          longitude,
          accuracy,
          durationMs: Math.round(performance.now() - locationStartedAt),
          positionTimestamp: position.timestamp,
        });

        try {
          const response = await fetchWithTimeout("/api/reverse-geocode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId, latitude, longitude }),
          }, 20000);
          const durationMs = Math.round(performance.now() - reverseStartedAt);
          if (!response.ok) {
            const failure = await response.json().catch(() => null) as { detail?: string; error?: string } | null;
            throw new Error(failure?.detail || failure?.error || `reverse-geocoding-http-${response.status}`);
          }
          const result = await response.json() as ReverseAddress;
          const parts = result.address || {};
          city = parts.city || parts.municipality || parts.town || parts.county || parts.state || city;
          address = result.display_name || address;
          addressResolution = { requestId, status: "success", durationMs, httpStatus: response.status };
        } catch (reverseError) {
          addressResolution = {
            requestId,
            status: "failed",
            durationMs: Math.round(performance.now() - reverseStartedAt),
            error: errorDescription(reverseError),
          };
          locationLog("reverse_geocode_failed", { ...addressResolution, latitude, longitude, mode: "article" });
        }

        try {
          let deviceId = localStorage.getItem("shenxiang_device_id");
          if (!deviceId) {
            deviceId = crypto.randomUUID();
            localStorage.setItem("shenxiang_device_id", deviceId);
          }
          const uploadResponse = await fetchWithTimeout("/api/location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ city, address, latitude, longitude, accuracy, deviceId, consent: true, addressResolution }),
          });
          if (!uploadResponse.ok) throw new Error(`location-upload-http-${uploadResponse.status}`);

          const consentedAt = new Date().toISOString();
          localStorage.setItem("shenxiang_location", JSON.stringify({
            city,
            address,
            precision: "precise",
            latitude,
            longitude,
            accuracy,
            source: "browser-geolocation+amap",
            consentedAt,
            refreshedAt: consentedAt,
            consentExpiresAt,
          }));
          localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
          localStorage.setItem(LOCATION_LAST_REFRESH_KEY, String(Date.now()));
          setConsentExpiresAt(consentExpiresAt);
          setOpen(false);
          locationLog("location_saved", { requestId, mode: "article", consentExpiresAt });
        } catch (uploadError) {
          locationLog("upload_failed", { requestId, mode: "article", error: errorDescription(uploadError) });
          setError("位置提交失败，请稍后重试。");
        } finally {
          setRequesting(false);
        }
      },
      (geolocationError) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        setRequesting(false);
        setError("无法获取位置，请在浏览器中允许定位后重试。");
        locationLog("geolocation_failed", {
          requestId,
          mode: "article",
          code: geolocationError.code,
          message: geolocationError.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop published-location-backdrop">
      <section className="modal published-location-modal" role="dialog" aria-modal="true" aria-label="位置授权">
        <div className="simple-consent">
          <span className="location-symbol">⌖</span>
          <h2>帮你发现同城黑料秘密㊙️</h2>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary" type="button" disabled={requesting} onClick={requestLocation}>
            {requesting ? "正在获取位置…" : "获取同城黑料"}
          </button>
        </div>
      </section>
    </div>
  );
}
