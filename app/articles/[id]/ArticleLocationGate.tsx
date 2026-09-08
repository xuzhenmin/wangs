"use client";

import { useEffect, useRef, useState } from "react";
import ArticleContentDisclosure from "./ArticleContentDisclosure";
import {
  assertLocationUploadAccepted,
  clearStoredLocationConsent,
  getStoredLocationConsentExpiry,
  isStoredLocationConsentRevoked,
  isStoredLocationAuthorized,
  rememberLocationConsent,
  scheduleLocationRefresh,
  LOCATION_PERMISSION_DENIED_MESSAGE,
  RevokedLocationConsentError,
} from "../../../lib/location-consent-browser";

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

const LOCATION_CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCATION_EXPIRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCATION_PROMPT_DELAY_MS = 5000;
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
  await assertLocationUploadAccepted(uploadResponse);

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
  if (consentExpiresAt <= Date.now() || !navigator.geolocation) return false;
  if (!navigator.permissions) {
    locationLog("background_refresh_skipped", { reason: "permission-query-unsupported" });
    return false;
  }
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state !== "granted") {
      locationLog("background_refresh_skipped", { reason: `permission-${permission.state}` });
      return false;
    }
  } catch (permissionError) {
    locationLog("background_permission_query_failed", { error: errorDescription(permissionError) });
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    let requestActive = true;
    const hardTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, mode: "background", durationMs: Math.round(performance.now() - locationStartedAt) });
      resolve(false);
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
          if (refreshError instanceof RevokedLocationConsentError) {
            locationLog("background_refresh_revoked", { requestId });
            resolve(true);
            return;
          }
          locationLog("background_refresh_failed", { requestId, error: errorDescription(refreshError) });
        }
        resolve(false);
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
        resolve(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 },
    );
  });
}

export default function ArticleLocationGate({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [consentExpiresAt, setConsentExpiresAt] = useState(0);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [canExpand, setCanExpand] = useState(false);
  const [monitorPermission, setMonitorPermission] = useState(false);
  const retryPromptTimeoutRef = useRef<number | undefined>(undefined);
  const initialPromptTimeoutRef = useRef<number | undefined>(undefined);
  const previewModeRef = useRef(false);
  const previewNoticeRef = useRef<HTMLElement>(null);
  const locationRequestPendingRef = useRef(false);
  const [checkingConsent, setCheckingConsent] = useState(false);
  const checkingConsentRef = useRef(false);
  const latestCanExpandRef = useRef(canExpand);
  const mountedRef = useRef(true);

  useEffect(() => {
    latestCanExpandRef.current = canExpand;
  }, [canExpand]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const clearRetryPrompt = () => {
    if (initialPromptTimeoutRef.current !== undefined) {
      window.clearTimeout(initialPromptTimeoutRef.current);
      initialPromptTimeoutRef.current = undefined;
    }
    if (retryPromptTimeoutRef.current !== undefined) {
      window.clearTimeout(retryPromptTimeoutRef.current);
      retryPromptTimeoutRef.current = undefined;
    }
  };

  const showArticlePreview = () => {
    clearRetryPrompt();
    previewModeRef.current = true;
    setMonitorPermission(true);
    setCollapsed(true);
    setOpen(false);
    setRequestError("");
  };

  const scheduleRetryPrompt = (message: string) => {
    locationRequestPendingRef.current = false;
    clearRetryPrompt();
    setRequestError(message);
    setRequesting(false);
    setCanExpand(false);
    setCollapsed(true);
    setOpen(false);
    if (previewModeRef.current) return;
    retryPromptTimeoutRef.current = window.setTimeout(() => {
      retryPromptTimeoutRef.current = undefined;
      setOpen(true);
    }, LOCATION_RETRY_DELAY_MS);
  };

  useEffect(() => {
    let cancelled = false;
    const initializationTimeoutId = window.setTimeout(() => {
      void (async () => {
        const storedExpiry = getStoredLocationConsentExpiry();
        const remaining = storedExpiry - Date.now();
        if (remaining > 0) {
          try {
            if (await isStoredLocationConsentRevoked()) {
              if (cancelled) return;
              clearStoredLocationConsent();
              initialPromptTimeoutRef.current = window.setTimeout(() => setOpen(true), LOCATION_PROMPT_DELAY_MS);
              return;
            }
          } catch (statusError) {
            locationLog("consent_status_check_failed", { error: errorDescription(statusError) });
          }
          if (cancelled) return;
          localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(storedExpiry));
          setConsentExpiresAt(storedExpiry);
          setCanExpand(true);
          setMonitorPermission(true);
          return;
        }
        clearStoredLocationConsent();
        if (!cancelled) initialPromptTimeoutRef.current = window.setTimeout(() => setOpen(true), LOCATION_PROMPT_DELAY_MS);
      })();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(initializationTimeoutId);
      if (initialPromptTimeoutRef.current !== undefined) window.clearTimeout(initialPromptTimeoutRef.current);
    };
  }, []);

  useEffect(() => () => {
    if (retryPromptTimeoutRef.current !== undefined) window.clearTimeout(retryPromptTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!monitorPermission || !navigator.permissions) return;
    let cancelled = false;
    let checking = false;
    let permission: PermissionStatus | undefined;
    const syncPermission = () => {
      if (cancelled || !permission) return;
      // A grant enables the explicit expand action; it never expands or
      // starts a location upload by itself.
      const granted = permission.state === "granted";
      const hasActiveConsent = getStoredLocationConsentExpiry() > Date.now();
      setCanExpand(granted || (permission.state === "prompt" && hasActiveConsent));
      setPermissionDenied(permission.state === "denied");
      setRequestError("");
      if (permission.state === "denied") {
        setCollapsed(true);
        clearStoredLocationConsent();
        setConsentExpiresAt(0);
      } else if (!granted && !hasActiveConsent) {
        setCollapsed(true);
      }
    };
    const checkPermission = async () => {
      if (cancelled || checking) return;
      checking = true;
      try {
        const current = await navigator.permissions.query({ name: "geolocation" });
        if (cancelled) return;
        permission?.removeEventListener("change", syncPermission);
        permission = current;
        permission.addEventListener("change", syncPermission);
        syncPermission();
      } catch {
        // Some embedded browsers cannot query geolocation permission. The
        // explicit inline button remains available in that case.
      } finally {
        checking = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkPermission();
    };
    void checkPermission();
    window.addEventListener("focus", checkPermission);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      permission?.removeEventListener("change", syncPermission);
      window.removeEventListener("focus", checkPermission);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [monitorPermission]);

  useEffect(() => {
    if (!consentExpiresAt) return;
    const expireConsent = () => {
      clearStoredLocationConsent();
      setConsentExpiresAt(0);
      setCollapsed(true);
      setCanExpand(false);
      setPermissionDenied(false);
      setMonitorPermission(false);
      previewModeRef.current = false;
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
        const revoked = await refreshLocationIfGranted(consentExpiresAt);
        if (revoked && !cancelled) {
          clearStoredLocationConsent();
          setConsentExpiresAt(0);
          setCollapsed(true);
          setCanExpand(false);
          setPermissionDenied(false);
          setMonitorPermission(false);
          previewModeRef.current = false;
          setOpen(true);
        }
      } finally {
        refreshing = false;
      }
    };
    const stopRefresh = scheduleLocationRefresh(refresh);
    return () => {
      cancelled = true;
      stopRefresh();
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

  const requestLocation = (expandAfterSuccess = false) => {
    if (locationRequestPendingRef.current) return;
    clearRetryPrompt();
    if (!window.isSecureContext) {
      scheduleRetryPrompt("当前连接不支持定位，请使用 HTTPS 地址打开网站后重试。");
      return;
    }
    if (!navigator.geolocation) {
      locationLog("geolocation_unsupported", { mode: "article" });
      scheduleRetryPrompt("当前浏览器不支持定位，请使用系统浏览器打开此页面后重试。");
      return;
    }

    setRequestError("");
    locationRequestPendingRef.current = true;
    setRequesting(true);
    // Hide our overlay before opening the native permission prompt. Some
    // browsers only report a grant once coordinates arrive, which can be slow.
    setOpen(false);
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "article", timeoutMs: 12000, hardTimeoutMs: 15000 });
    let requestActive = true;
    const hardTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, mode: "article", durationMs: Math.round(performance.now() - locationStartedAt) });
      scheduleRetryPrompt("获取位置超时，请检查设备定位服务和网络后重试。");
    }, 15000);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(hardTimeoutId);
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        const { latitude, longitude, accuracy } = position.coords;
        try {
          rememberLocationConsent(consentExpiresAt);
        } catch (storageError) {
          locationLog("consent_storage_failed", { error: errorDescription(storageError) });
        }
        setConsentExpiresAt(consentExpiresAt);

        // Only an explicit expand click carries the intent to reveal content.
        // A grant from the separate consent dialog still waits for that click.
        clearRetryPrompt();
        setCanExpand(true);
        setPermissionDenied(false);
        setMonitorPermission(true);
        setOpen(false);
        if (expandAfterSuccess) {
          previewModeRef.current = true;
          setCollapsed(false);
        }

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
          setOpen(false);
        } catch (uploadError) {
          locationLog("upload_failed", { requestId, mode: "article", error: errorDescription(uploadError) });
          setRequestError("位置保存失败，请检查网络后重试。");
        } finally {
          locationRequestPendingRef.current = false;
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
        scheduleRetryPrompt(geolocationError.code === 1
          ? LOCATION_PERMISSION_DENIED_MESSAGE
          : geolocationError.code === 3
            ? "获取位置超时，请检查设备定位服务和网络后重试。"
            : "暂时无法获取位置，请开启设备定位服务后重试。");
        if (geolocationError.code === 1) {
          setPermissionDenied(true);
          if (previewModeRef.current) setCollapsed(true);
        }
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  };

  const expandContent = async () => {
    if (checkingConsentRef.current) return;
    clearRetryPrompt();
    // No device identifier means there is no previous server consent to check.
    // Never treat an unidentifiable visitor as an already authorized visitor.
    const deviceId = localStorage.getItem("shenxiang_device_id");
    if (!deviceId) {
      requestLocation(true);
      return;
    }
    checkingConsentRef.current = true;
    setCheckingConsent(true);
    setRequestError("");
    try {
      const authorized = await isStoredLocationAuthorized();
      if (!mountedRef.current) return;
      if (localStorage.getItem("shenxiang_device_id") !== deviceId) {
        throw new Error("location-identity-changed");
      }
      if (!authorized) {
        clearStoredLocationConsent();
        setConsentExpiresAt(0);
        setCanExpand(false);
        setCollapsed(true);
        setPermissionDenied(false);
        setMonitorPermission(false);
        requestLocation(true);
      } else if (!latestCanExpandRef.current) {
        requestLocation(true);
      } else {
        previewModeRef.current = true;
        setCollapsed(false);
        setOpen(false);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      locationLog("expand_consent_check_failed", { error: errorDescription(error) });
      setCollapsed(true);
      setRequestError("授权状态验证失败，请检查网络后点击展开重试。");
    } finally {
      checkingConsentRef.current = false;
      if (mountedRef.current) setCheckingConsent(false);
    }
  };

  return (
    <>
      <ArticleContentDisclosure content={content} collapsed={collapsed} />
      {collapsed && (
        <section ref={previewNoticeRef} tabIndex={-1} className="published-content-unlock" aria-label="展开剩余内容">
          <p role="status">{canExpand ? "点击展开阅读全文。" : "允许位置访问后，可展开阅读全文。"}</p>
          {requestError && <p className="published-location-error" id="article-location-inline-error" role="alert">{requestError}</p>}
          <button
            className="published-content-expand"
            type="button"
            aria-label="展开"
            title={canExpand ? "展开阅读全文" : "授权位置并展开全文"}
            disabled={checkingConsent || (requesting && !canExpand)}
            aria-busy={checkingConsent || (requesting && !canExpand)}
            aria-expanded={false}
            aria-controls="article-readable-content"
            aria-describedby={requestError ? "article-location-inline-error" : undefined}
            onClick={expandContent}
          >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="m6 7 6 6 6-6M6 13l6 6 6-6" />
              </svg>
          </button>
        </section>
      )}
      {!open && !collapsed && requestError && <p className="published-location-error" role="alert">{requestError}</p>}
      {open && (
        <div className="modal-backdrop published-location-backdrop">
          <section className="modal published-location-modal location-retry-modal" role="dialog" aria-modal="true" aria-label="位置授权">
            {requestError && <p className="published-location-error" id="article-location-error" role="alert">{requestError}</p>}
            <button
              className="primary published-location-action"
              type="button"
              disabled={requesting}
              aria-busy={requesting}
              aria-describedby={requestError ? "article-location-error" : undefined}
              onClick={permissionDenied ? showArticlePreview : () => requestLocation()}
            >
              提升推荐内容质量，获取所在省份信息
            </button>
            <small className="location-privacy-note">不用作任何商业用途</small>
          </section>
        </div>
      )}
    </>
  );
}
