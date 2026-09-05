"use client";

import { useEffect, useRef, useState } from "react";

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

const LOCATION_CONSENT_TTL_MS = 100 * 24 * 60 * 60 * 1000;
const LOCATION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const LOCATION_EXPIRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCATION_PROMPT_DELAY_MS = 2500;
const LOCATION_RETRY_DELAY_MS = 3000;
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
      if (Number.isFinite(consentedAt)) return consentedAt + LOCATION_CONSENT_TTL_MS;
    }
  } catch {
    return 0;
  }

  return savedExpiry;
}

async function resolveAndStoreLocation(
  position: GeolocationPosition,
  requestId: string,
  consentExpiresAt: number,
  mode: "article" | "background",
  renewConsent: boolean,
) {
  const { latitude, longitude, accuracy } = position.coords;
  const savedLocation = localStorage.getItem("shenxiang_location");
  let city = "未知城市";
  let originalConsentedAt = new Date().toISOString();
  if (savedLocation) {
    try {
      const parsed = JSON.parse(savedLocation) as { city?: unknown; consentedAt?: unknown };
      if (typeof parsed.city === "string" && parsed.city.trim()) city = parsed.city;
      if (!renewConsent && typeof parsed.consentedAt === "string") originalConsentedAt = parsed.consentedAt;
    } catch {
      // Replace malformed local state with the latest valid location.
    }
  }

  let address = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  const reverseStartedAt = performance.now();
  let addressResolution: AddressResolutionDiagnostics;
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
    locationLog("reverse_geocode_failed", { ...addressResolution, latitude, longitude, mode });
  }

  let deviceId = localStorage.getItem("shenxiang_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("shenxiang_device_id", deviceId);
  }
  const uploadResponse = await fetchWithTimeout("/api/location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, address, latitude, longitude, accuracy, deviceId, consent: true, addressResolution, renewConsent }),
  });
  if (!uploadResponse.ok) throw new Error(`location-upload-http-${uploadResponse.status}`);

  const refreshedAt = Date.now();
  localStorage.setItem("shenxiang_location", JSON.stringify({
    city,
    address,
    precision: "precise",
    latitude,
    longitude,
    accuracy,
    source: "browser-geolocation+amap",
    consentedAt: originalConsentedAt,
    refreshedAt: new Date(refreshedAt).toISOString(),
    consentExpiresAt,
  }));
  localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
  localStorage.setItem(LOCATION_LAST_REFRESH_KEY, String(refreshedAt));
  locationLog("location_saved", { requestId, mode, consentExpiresAt });
}

async function refreshLocationIfGranted(consentExpiresAt: number) {
  if (consentExpiresAt <= Date.now() || !navigator.geolocation) return;
  if (navigator.permissions) {
    try {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      if (permission.state !== "granted") {
        locationLog("background_refresh_skipped", { reason: `permission-${permission.state}` });
        return;
      }
    } catch (permissionError) {
      locationLog("background_permission_query_failed", { error: errorDescription(permissionError) });
      return;
    }
  }

  await new Promise<void>((resolve) => {
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    let requestActive = true;
    const hardTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, mode: "background", durationMs: Math.round(performance.now() - locationStartedAt) });
      resolve();
    }, 12000);
    locationLog("geolocation_requested", { requestId, mode: "background", timeoutMs: 8000, hardTimeoutMs: 12000 });
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        try {
          await resolveAndStoreLocation(position, requestId, consentExpiresAt, "background", false);
        } catch (refreshError) {
          locationLog("background_refresh_failed", { requestId, error: errorDescription(refreshError) });
        }
        resolve();
      },
      (geolocationError) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        locationLog("geolocation_failed", {
          requestId,
          mode: "background",
          code: geolocationError.code,
          message: geolocationError.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
        resolve();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 },
    );
  });
}

export default function ArticleLocationGate() {
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [consentExpiresAt, setConsentExpiresAt] = useState(0);
  const justAuthorizedRef = useRef(false);
  const retryPromptTimeoutRef = useRef<number | undefined>(undefined);

  const scheduleRetryPrompt = () => {
    if (retryPromptTimeoutRef.current !== undefined) window.clearTimeout(retryPromptTimeoutRef.current);
    setRequesting(false);
    setOpen(false);
    retryPromptTimeoutRef.current = window.setTimeout(() => {
      retryPromptTimeoutRef.current = undefined;
      setOpen(true);
    }, LOCATION_RETRY_DELAY_MS);
  };

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

  useEffect(() => () => {
    if (retryPromptTimeoutRef.current !== undefined) window.clearTimeout(retryPromptTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!consentExpiresAt) return;
    const expireConsent = () => {
      clearStoredLocation();
      setConsentExpiresAt(0);
      setOpen(true);
    };
    let expiryTimeoutId: number | undefined;
    const scheduleExpiryCheck = () => {
      const remaining = consentExpiresAt - Date.now();
      if (remaining <= 0) {
        expireConsent();
        return;
      }
      expiryTimeoutId = window.setTimeout(
        scheduleExpiryCheck,
        Math.min(remaining, LOCATION_EXPIRY_CHECK_INTERVAL_MS),
      );
    };
    scheduleExpiryCheck();
    return () => {
      if (expiryTimeoutId !== undefined) window.clearTimeout(expiryTimeoutId);
    };
  }, [consentExpiresAt]);

  useEffect(() => {
    if (!consentExpiresAt || consentExpiresAt <= Date.now()) return;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        await refreshLocationIfGranted(consentExpiresAt);
      } finally {
        refreshing = false;
      }
    };
    const shouldRefreshImmediately = !justAuthorizedRef.current;
    justAuthorizedRef.current = false;
    const initialRefreshId = shouldRefreshImmediately
      ? window.setTimeout(() => void refresh(), 0)
      : undefined;
    const refreshIntervalId = window.setInterval(() => void refresh(), LOCATION_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (initialRefreshId !== undefined) window.clearTimeout(initialRefreshId);
      window.clearInterval(refreshIntervalId);
    };
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
    if (!navigator.geolocation) {
      locationLog("geolocation_unsupported", { mode: "article" });
      scheduleRetryPrompt();
      return;
    }

    setRequesting(true);
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "article", timeoutMs: 12000, hardTimeoutMs: 15000 });
    let requestActive = true;
    const hardTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, mode: "article", durationMs: Math.round(performance.now() - locationStartedAt) });
      scheduleRetryPrompt();
    }, 15000);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        const { latitude, longitude, accuracy } = position.coords;

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
          await resolveAndStoreLocation(position, requestId, consentExpiresAt, "article", true);
          if (retryPromptTimeoutRef.current !== undefined) {
            window.clearTimeout(retryPromptTimeoutRef.current);
            retryPromptTimeoutRef.current = undefined;
          }
          justAuthorizedRef.current = true;
          setConsentExpiresAt(consentExpiresAt);
          setOpen(false);
        } catch (uploadError) {
          locationLog("upload_failed", { requestId, mode: "article", error: errorDescription(uploadError) });
          scheduleRetryPrompt();
        } finally {
          setRequesting(false);
        }
      },
      (geolocationError) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        locationLog("geolocation_failed", {
          requestId,
          mode: "article",
          code: geolocationError.code,
          message: geolocationError.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
        scheduleRetryPrompt();
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop published-location-backdrop">
      <section className="modal published-location-modal" role="dialog" aria-modal="true" aria-label="位置授权">
        <button
          className="primary published-location-action"
          type="button"
          disabled={requesting}
          aria-busy={requesting}
          onClick={requestLocation}
        >
          发现同城黑料
        </button>
      </section>
    </div>
  );
}
