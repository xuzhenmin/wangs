"use client";

import { useEffect, useState } from "react";

type GateStep = "closed" | "initialConsent" | "register" | "location" | "success";

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
  { tag: "恋情传闻", title: "从“神秘富豪”到孙宇晨，这条传闻是怎么传开的", meta: "12 分钟前 · 5.4k 热度", tone: "amber" },
  { tag: "万字长文", title: "写满恋爱细节，结尾为何又标注“纯属虚构”？", meta: "38 分钟前 · 6.2k 热度", tone: "blue" },
  { tag: "三千万之争", title: "这笔钱是彩礼还是赠与？双方把争议带进法院", meta: "1 小时前 · 8.1k 热度", tone: "red" },
];

const briefs = [
  ["5 月", "网络出现“神秘富豪”传闻，景甜工作室发声明否认"],
  ["8 月 27 日", "律师披露三千余万元财产诉讼，事件再次升温"],
  ["同日", "孙宇晨发布万字长文，文末注明内容纯属虚构"],
  ["当晚", "景甜工作室回应称相信法律，一切交由法院处理"],
];

const LOCATION_CONSENT_TTL_MS = 30 * 60 * 1000;
const LOCATION_CONSENT_EXPIRES_KEY = "shenxiang_location_consent_expires_at";

export default function Home() {
  const [gate, setGate] = useState<GateStep>("initialConsent");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [registered, setRegistered] = useState(false);
  const [hasLocation, setHasLocation] = useState(false);
  const [city, setCity] = useState("上海市");
  const [precise, setPrecise] = useState(false);
  const [notice, setNotice] = useState("");
  const [dateLabel, setDateLabel] = useState("今日");
  const [locationConsentExpiresAt, setLocationConsentExpiresAt] = useState(0);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDateLabel(
        new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(new Date())
      );
      setRegistered(localStorage.getItem("shenxiang_member") === "active");
      const savedLocation = localStorage.getItem("shenxiang_location");
      const savedConsentExpiresAt = Number(localStorage.getItem(LOCATION_CONSENT_EXPIRES_KEY));
      const hasActiveConsent = Boolean(savedLocation) && Number.isFinite(savedConsentExpiresAt) && savedConsentExpiresAt > Date.now();
      localStorage.removeItem("shenxiang_location_prompted");
      if (hasActiveConsent) {
        setHasLocation(true);
        setLocationConsentExpiresAt(savedConsentExpiresAt);
        setGate("closed");
        return;
      }
      localStorage.removeItem("shenxiang_location");
      localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
      setHasLocation(false);
      setGate("initialConsent");
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!locationConsentExpiresAt) return;
    const expireConsent = () => {
      localStorage.removeItem("shenxiang_location");
      localStorage.removeItem(LOCATION_CONSENT_EXPIRES_KEY);
      setHasLocation(false);
      setLocationConsentExpiresAt(0);
      setGate("initialConsent");
    };
    const remaining = locationConsentExpiresAt - Date.now();
    if (remaining <= 0) {
      expireConsent();
      return;
    }
    const timeoutId = window.setTimeout(expireConsent, remaining);
    return () => window.clearTimeout(timeoutId);
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
    if (registered) {
      setNotice("该栏目将在下一期开放，已为你保留同城订阅。");
      window.setTimeout(() => setNotice(""), 2800);
      return;
    }
    setGate("register");
  };

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    if (code.trim().toUpperCase() !== "CITY-0830") {
      setCodeError("授权码无效，请检查后重试。");
      return;
    }
    setCodeError("");
    setGate("location");
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
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      zoom: "18",
      addressdetails: "1",
      "accept-language": "zh-CN,zh,en",
    });
    locationLog("reverse_geocode_started", { latitude, longitude, timeoutMs: 6000 });
    const response = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {}, 6000);
    const durationMs = Math.round(performance.now() - startedAt);
    locationLog("reverse_geocode_response", { status: response.status, ok: response.ok, durationMs });
    if (!response.ok) throw new Error(`reverse-geocoding-http-${response.status}`);
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
      body: JSON.stringify({ ...location, deviceId, consent: true, addressResolution }),
    }, 8000);
    const durationMs = Math.round(performance.now() - startedAt);
    locationLog("upload_response", { requestId: addressResolution.requestId, status: response.status, ok: response.ok, durationMs });
    if (!response.ok) throw new Error(`location-upload-http-${response.status}`);
  };

  const requestDetailedLocation = () => {
    const requestId = crypto.randomUUID();
    const locationStartedAt = performance.now();
    locationLog("geolocation_requested", { requestId, mode: "initial", timeoutMs: 12000, hardTimeoutMs: 15000 });
    if (!navigator.geolocation) {
      locationLog("geolocation_unsupported", { requestId });
      return;
    }
    let requestActive = true;
    const locationTimeoutId = window.setTimeout(() => {
      requestActive = false;
      locationLog("geolocation_hard_timeout", { requestId, durationMs: Math.round(performance.now() - locationStartedAt) });
    }, 15000);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (!requestActive) return;
        requestActive = false;
        window.clearTimeout(locationTimeoutId);
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
          locationLog("reverse_geocode_failed", { ...addressResolution, latitude, longitude });
        }
        try {
          await uploadConsentedLocation({ city: resolvedCity, address: resolvedAddress, latitude, longitude, accuracy }, addressResolution);
          const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
          localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
          localStorage.setItem("shenxiang_location", JSON.stringify({
            city: resolvedCity,
            address: resolvedAddress,
            precision: "precise",
            latitude,
            longitude,
            accuracy,
            source: "browser-geolocation+nominatim",
            consentedAt: new Date().toISOString(),
            consentExpiresAt,
          }));
          setCity(resolvedCity);
          setHasLocation(true);
          setLocationConsentExpiresAt(consentExpiresAt);
          setGate("closed");
        } catch (error) {
          locationLog("upload_failed", { requestId, error: errorDescription(error) });
          // Location collection is best-effort and never blocks content access.
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
        let resolvedAddress = "地址名称暂时解析失败，已保存定位坐标";
        let resolvedCity = city;
        const reverseStartedAt = performance.now();
        let addressResolution: AddressResolutionDiagnostics;
        try {
          const { result, httpStatus, durationMs } = await reverseGeocode(latitude, longitude);
          const parts = result.address || {};
          resolvedCity = parts.city || parts.municipality || parts.town || parts.county || parts.state || city;
          resolvedAddress = result.display_name || resolvedAddress;
          addressResolution = { requestId, status: "success", durationMs, httpStatus };
        } catch (error) {
          addressResolution = {
            requestId,
            status: "failed",
            durationMs: Math.round(performance.now() - reverseStartedAt),
            error: errorDescription(error),
          };
          locationLog("reverse_geocode_failed", { ...addressResolution, latitude, longitude });
        }
        try {
          await uploadConsentedLocation({ city: resolvedCity, address: resolvedAddress, latitude, longitude, accuracy }, addressResolution);
        } catch (error) {
          locationLog("upload_failed", { requestId, error: errorDescription(error) });
          return;
        }
        const consentExpiresAt = Date.now() + LOCATION_CONSENT_TTL_MS;
        localStorage.setItem(LOCATION_CONSENT_EXPIRES_KEY, String(consentExpiresAt));
        localStorage.setItem(
          "shenxiang_location",
          JSON.stringify({
            city: resolvedCity,
            address: resolvedAddress,
            precision: "precise",
            latitude,
            longitude,
            accuracy,
            source: "browser-geolocation+nominatim",
            consentedAt: new Date().toISOString(),
            consentExpiresAt,
          })
        );
        setHasLocation(true);
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
    <main className={`home-page${gate === "initialConsent" ? " location-locked" : ""}`}>
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
          <strong>热瓜</strong><span>广告已经过滤，保留完整八卦时间线。</span><span className="ticker-dot">•</span><span>传闻部分均有标注，案件仍待法院审理</span>
        </div>
      </section>

      <section className="hero page-shell">
        <div className="hero-copy">
          <div className="eyebrow"><span>今日热瓜</span><i /></div>
          <h1>三千万风波再升级：<br />一篇万字长文把传闻推上热搜</h1>
          <p className="dek">神秘富豪、恋情传闻、巨额转账、法院诉讼——一次看懂这场风波如何发酵。保留八卦脉络，剔除广告与来源不明的私密材料。</p>
          <div className="byline"><span className="avatar">瓜</span><div><b>深巷吃瓜编辑部</b><small>8 月 30 日更新 · 阅读约 5 分钟</small></div></div>
          <button className="read-button" onClick={() => document.getElementById("feature-story")?.scrollIntoView({ behavior: "smooth" })}>
            阅读完整报道 <span>↗</span>
          </button>
        </div>
        <div className="hero-art hero-photo" aria-label="法院新闻发布区域示意图">
          <img className="hero-photo-image" src="/editorial-dispute-v1.png" alt="法院走廊、文件夹与两支话筒组成的新闻示意图" />
          <div className="photo-caption"><span>CASE FILE</span><b>司法程序进行中</b><small>原创示意图 · 非案件现场</small></div>
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
          <div className="section-title"><span>吃瓜梳理</span><h2>整件事是怎么发酵的</h2></div>
          <h3>从“神秘富豪”到三千万诉讼：<br />这场风波的四个关键看点</h3>
          <p className="lead">故事最初来自网络上的“神秘富豪男友”传闻。几个月后，孙宇晨一方披露财产诉讼，又发布一篇带有大量恋爱叙事、却在结尾注明“纯属虚构”的长文，让事件迅速冲上舆论中心。</p>
          <p>今年 5 月，网上曾出现涉及景甜的恋情和经济纠纷传闻。景甜工作室当时将相关内容称为不实信息，并表示已经取证、将依法追责。彼时“神秘富豪”身份并没有得到可靠确认。</p>
          <p>8 月 27 日，孙宇晨一方的代理律师披露，已就三千余万元财产争议提起民事诉讼。随后发布的万字长文使用第一人称讲述所谓恋爱经历，但文末又明确标注内容纯属虚构，因此长文细节不能直接当作案件证据或既定事实。</p>
          <div className="gossip-box">
            <h4>这场瓜目前最受关注的四个问题</h4>
            <ul>
              <li><b>两人是否确有恋爱关系？</b><span>网络传闻很多，但双方并未共同公开确认完整关系时间线。</span></li>
              <li><b>三千余万元究竟是什么性质？</b><span>原告方主张返还，被告方立场不同，最终要看法院认定。</span></li>
              <li><b>万字长文能不能当真？</b><span>文章自己标注“纯属虚构”，其中猎奇细节不能视为已证实信息。</span></li>
              <li><b>案件现在有结果了吗？</b><span>目前仍处于司法程序中，尚无最终生效裁判。</span></li>
            </ul>
          </div>
          <p>景甜工作室随后公开回应，表示相信法律并将争议交由法院处理。双方说法针锋相对，恰恰也是这场八卦持续升温的原因。</p>
          <div className="quote">“瓜可以吃，时间线可以看，但网传截图、私密材料和单方面叙述都不能替代法院认定。”</div>
          <p>原页面中的广告、博彩、交友和成人推广已全部剔除；所谓不雅影像、AI 换脸视频及来源不明的私人材料不转载、不展示。</p>
          <p className="source-note">资料核对：<a href="https://www.sina.cn/news/detail/5336632517471260.html" target="_blank" rel="noreferrer">公开诉讼进展报道</a>、<a href="https://k.sina.com.cn/article_7879996051_1d5af32930680190g6.html" target="_blank" rel="noreferrer">双方回应梳理</a>。后续以法院生效裁判与当事方正式声明为准。</p>
        </article>

        <aside className="sidebar">
          <div className="brief-head"><span>热瓜时间线</span><small>LIVE</small></div>
          {briefs.map(([time, text]) => (
            <button className="brief" onClick={openGate} key={time}><time>{time}</time><span>{text}</span><i>→</i></button>
          ))}
          <div className="member-card">
            <small>MEMBERS ONLY</small>
            <h4>解锁你附近的<br />同城黑料线索</h4>
            <p>只展示黑料内容，不插入广告；定位授权每 30 分钟重新确认一次。</p>
            <button onClick={openGate}>{registered ? "查看同城订阅" : "使用授权码加入"}</button>
          </div>
        </aside>
      </section>

      <footer>
        <div className="page-shell footer-inner"><a className="brand small" href="#top">深<span>巷</span></a><p>只做线索梳理，不接广告推广。</p><div><button onClick={() => setNotice("精确位置仅在你主动同意后上传，用于推荐同城内容，最长保留 30 天。")}>隐私说明</button><button onClick={openGate}>联系编辑部</button></div></div>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}

      {gate !== "closed" && (
        <div className="modal-backdrop" onMouseDown={() => { if (gate !== "initialConsent") setGate("closed"); }}>
          <section className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="位置与会员授权">
            {gate !== "initialConsent" && <button className="modal-close" aria-label="关闭" onClick={() => setGate("closed")}>×</button>}
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
            {gate === "success" && (
              <div className="success-state"><span className="success-mark">✓</span><h2>同城频道已解锁</h2><p>你已完成注册，可以开始查看同城内容。</p><button className="primary" onClick={() => setGate("closed")}>开始阅读</button></div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
