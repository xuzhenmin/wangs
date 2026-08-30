"use client";

import { useEffect, useMemo, useState } from "react";

type GateStep = "closed" | "initialConsent" | "addressSuccess" | "register" | "location" | "success";

type ReverseAddress = {
  display_name?: string;
  address?: Record<string, string>;
};

const stories = [
  { tag: "街区", title: "凌晨四点，河西旧市场为何还亮着灯？", meta: "12 分钟前 · 1.8k 热度", tone: "amber" },
  { tag: "追踪", title: "消失的共享单车，最后都去了哪里", meta: "38 分钟前 · 996 热度", tone: "blue" },
  { tag: "独家", title: "一张停业通知背后的三次改口", meta: "1 小时前 · 2.4k 热度", tone: "red" },
];

const briefs = [
  ["21:36", "老厂房改造方案公布，保留两栋历史建筑"],
  ["20:58", "地铁西延线完成首次全线联调"],
  ["19:42", "社区夜校秋季课程今晚开放报名"],
  ["18:15", "本周末沿江步道部分路段临时管制"],
];

export default function Home() {
  const [gate, setGate] = useState<GateStep>("closed");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [registered, setRegistered] = useState(false);
  const [hasLocation, setHasLocation] = useState(false);
  const [city, setCity] = useState("上海市");
  const [precise, setPrecise] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [notice, setNotice] = useState("");
  const [detailedAddress, setDetailedAddress] = useState("");

  useEffect(() => {
    setRegistered(localStorage.getItem("shenxiang_member") === "active");
    const savedLocation = localStorage.getItem("shenxiang_location");
    setHasLocation(Boolean(savedLocation));
    const hasAnsweredPrompt = localStorage.getItem("shenxiang_location_prompted");
    if (!savedLocation && !hasAnsweredPrompt) setGate("initialConsent");
  }, []);

  const dateLabel = useMemo(
    () => new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date()),
    []
  );

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
      setCodeError("授权码无效，请检查后重试。体验码为 CITY-0830");
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
    setGate("success");
  };

  const reverseGeocode = async (latitude: number, longitude: number) => {
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      zoom: "18",
      addressdetails: "1",
      "accept-language": "zh-CN,zh,en",
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`);
    if (!response.ok) throw new Error("reverse-geocoding-failed");
    return response.json() as Promise<ReverseAddress>;
  };

  const requestDetailedLocation = () => {
    if (!navigator.geolocation) {
      setLocationError("当前浏览器不支持定位服务，你可以暂不授权并继续浏览。");
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        try {
          const result = await reverseGeocode(latitude, longitude);
          const parts = result.address || {};
          const resolvedCity = parts.city || parts.municipality || parts.town || parts.county || parts.state || city;
          const resolvedAddress = result.display_name || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
          localStorage.setItem("shenxiang_location_prompted", "accepted");
          localStorage.setItem("shenxiang_location", JSON.stringify({
            city: resolvedCity,
            address: resolvedAddress,
            precision: "precise",
            latitude,
            longitude,
            accuracy,
            source: "browser-geolocation+nominatim",
            consentedAt: new Date().toISOString(),
          }));
          setCity(resolvedCity);
          setDetailedAddress(resolvedAddress);
          setHasLocation(true);
          setGate("addressSuccess");
        } catch {
          localStorage.setItem("shenxiang_location_prompted", "accepted");
          localStorage.setItem("shenxiang_location", JSON.stringify({
            city,
            address: "地址名称暂时解析失败，已保存定位坐标",
            precision: "precise",
            latitude,
            longitude,
            accuracy,
            source: "browser-geolocation",
            consentedAt: new Date().toISOString(),
          }));
          setDetailedAddress("地址名称暂时解析失败，已保存定位坐标");
          setHasLocation(true);
          setGate("addressSuccess");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocationError("没有获得定位权限。请在浏览器中允许位置访问，或选择暂不授权。");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  };

  const dismissInitialConsent = () => {
    localStorage.setItem("shenxiang_location_prompted", "declined");
    setLocationError("");
    setGate("closed");
  };

  const requestPreciseLocation = () => {
    if (!precise) {
      saveCityOnly();
      return;
    }
    if (!navigator.geolocation) {
      setLocationError("当前浏览器不支持定位，请关闭精确定位后继续。");
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        let resolvedAddress = "地址名称暂时解析失败，已保存定位坐标";
        let resolvedCity = city;
        try {
          const result = await reverseGeocode(latitude, longitude);
          const parts = result.address || {};
          resolvedCity = parts.city || parts.municipality || parts.town || parts.county || parts.state || city;
          resolvedAddress = result.display_name || resolvedAddress;
        } catch { /* coordinates remain available when address lookup is temporarily unavailable */ }
        localStorage.setItem("shenxiang_member", "active");
        localStorage.setItem("shenxiang_location_prompted", "accepted");
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
          })
        );
        setRegistered(true);
        setHasLocation(true);
        setLocating(false);
        setGate("success");
      },
      () => {
        setLocating(false);
        setLocationError("没有获得定位权限。你仍可关闭精确定位，仅保存城市后继续。");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  };

  const clearLocation = () => {
    localStorage.removeItem("shenxiang_location");
    localStorage.removeItem("shenxiang_location_prompted");
    localStorage.removeItem("shenxiang_member");
    setRegistered(false);
    setHasLocation(false);
    setNotice("本机保存的会员与位置信息已删除。");
    window.setTimeout(() => setNotice(""), 2800);
  };

  return (
    <main>
      <header className="site-header">
        <div className="topline page-shell">
          <span>{dateLabel}</span>
          <span className="edition">城市观察 · 夜间版</span>
          <button className="text-button" onClick={hasLocation || registered ? clearLocation : () => setGate("initialConsent")}>
            {hasLocation ? "已定位 · 删除数据" : registered ? "已授权 · 管理数据" : "授权位置"}
          </button>
        </div>
        <div className="masthead page-shell">
          <button className="menu-button" aria-label="打开栏目" onClick={openGate}><i /><i /></button>
          <a className="brand" href="#top" aria-label="深巷首页">深<span>巷</span></a>
          <div className="live-chip"><b /> 同城实时</div>
        </div>
        <nav className="nav page-shell" aria-label="主导航">
          {["首页", "同城", "追踪", "人物", "现场", "数据", "夜读"].map((item, index) => (
            <button key={item} className={index === 0 ? "active" : ""} onClick={index === 0 ? undefined : openGate}>{item}</button>
          ))}
        </nav>
      </header>

      <section className="ticker" id="top">
        <div className="page-shell ticker-inner">
          <strong>此刻</strong><span>街道会说话，我们负责听见。</span><span className="ticker-dot">•</span><span>今日已更新 28 条本地线索</span>
        </div>
      </section>

      <section className="hero page-shell">
        <div className="hero-copy">
          <div className="eyebrow"><span>本期封面</span><i /></div>
          <h1>城市更新之后，<br />谁还记得那条老街？</h1>
          <p className="dek">从最后一家修表铺，到即将熄灯的旧照相馆。我们用七天，记录一条街在改造前的最后二十四小时。</p>
          <div className="byline"><span className="avatar">闻</span><div><b>闻野 · 深巷调查组</b><small>8 月 30 日 20:12 · 阅读约 6 分钟</small></div></div>
          <button className="read-button" onClick={() => document.getElementById("feature-story")?.scrollIntoView({ behavior: "smooth" })}>
            阅读完整报道 <span>↗</span>
          </button>
        </div>
        <div className="hero-art" aria-label="旧城街巷抽象插画">
          <div className="moon" />
          <div className="building back"><i /><i /><i /></div>
          <div className="building front"><i /><i /><i /><i /></div>
          <div className="street-sign"><span>梧桐里</span><small>WUTONG LI</small></div>
          <span className="issue">VOL. 028</span>
          <p>城市档案 / 2026</p>
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
          <div className="section-title"><span>深度</span><h2>今日值得细读</h2></div>
          <h3>老街的最后一夜：<br />有人告别，有人重新开始</h3>
          <p className="lead">晚上九点，修表师傅周叔把挂钟一只只取下来。它们走着不同的时间，却会在明天一起停下。</p>
          <p>梧桐里不长，从东口走到西口不过八分钟。这里没有宏大的故事，只有早餐铺蒸笼升起的白汽、裁缝店门口晒着的蓝布，以及每天下午准时响起的自行车铃。</p>
          <p>改造通知贴出的第十七天，我们再次回到这里。居民们已经开始打包，商户则把最后一点存货摆到门外。有人说这是城市向前走必须付出的代价，也有人只是站在门口，久久没有说话。</p>
          <div className="quote">“一条街真正消失，不是房子拆掉的那天，而是再没人记得它原来是什么样子。”</div>
          <p>这不是一次猎奇的围观，而是一份城市记忆的留档。报道中的人物与地名均为虚构示例，不影射任何现实个人或事件。</p>
        </article>

        <aside className="sidebar">
          <div className="brief-head"><span>城市简报</span><small>LIVE</small></div>
          {briefs.map(([time, text]) => (
            <button className="brief" onClick={openGate} key={time}><time>{time}</time><span>{text}</span><i>→</i></button>
          ))}
          <div className="member-card">
            <small>MEMBERS ONLY</small>
            <h4>解锁你附近<br />正在发生的事</h4>
            <p>授权码会员可查看城市级内容；精确位置始终为可选项。</p>
            <button onClick={openGate}>{registered ? "查看同城订阅" : "使用授权码加入"}</button>
          </div>
        </aside>
      </section>

      <footer>
        <div className="page-shell footer-inner"><a className="brand small" href="#top">深<span>巷</span></a><p>记录街巷，也尊重每一个生活其中的人。</p><div><button onClick={() => setNotice("定位仅在你主动同意后保存于本机，可随时删除。")}>隐私说明</button><button onClick={openGate}>联系编辑部</button></div></div>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}

      {gate !== "closed" && (
        <div className="modal-backdrop" onMouseDown={gate === "initialConsent" ? dismissInitialConsent : () => setGate("closed")}>
          <section className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="位置与会员授权">
            <button className="modal-close" aria-label="关闭" onClick={gate === "initialConsent" ? dismissInitialConsent : () => setGate("closed")}>×</button>
            {gate === "initialConsent" && (
              <div>
                <span className="modal-index">位置授权</span>
                <h2>发现你附近的城市故事</h2>
                <p>为了推荐同城内容，我们希望在你同意后获取当前位置，并解析为街道级详细地址。</p>
                <div className="consent-facts">
                  <span><b>你将共享</b>经纬度、定位精度和解析后的详细地址</span>
                  <span><b>地址解析</b>坐标会发送给 OpenStreetMap Nominatim 服务</span>
                  <span><b>保存位置</b>仅保存在当前设备，不上传至深巷服务器</span>
                </div>
                {locationError && <div className="form-error">{locationError}</div>}
                <button className="primary" type="button" disabled={locating} onClick={requestDetailedLocation}>{locating ? "正在获取并解析地址…" : "同意并获取详细地址"}</button>
                <button className="secondary" type="button" disabled={locating} onClick={dismissInitialConsent}>暂不授权，继续浏览</button>
                <small className="privacy-footnote">定位结果可能因设备与地图数据产生偏差，可在页首随时删除。</small>
              </div>
            )}
            {gate === "addressSuccess" && (
              <div className="success-state">
                <span className="success-mark">✓</span><h2>地址授权完成</h2>
                <p>已获取并仅在当前设备保存以下地址：</p>
                <div className="address-result">{detailedAddress}</div>
                <button className="primary" onClick={() => setGate("closed")}>继续浏览</button>
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
                <small className="demo-code">体验授权码：<b>CITY-0830</b></small>
              </form>
            )}
            {gate === "location" && (
              <div>
                <span className="modal-index">02 / 02</span>
                <h2>选择位置分享范围</h2>
                <p>城市级位置用于推荐同城报道；只有你打开下方选项并允许浏览器定位，才会在本机保存坐标。</p>
                <label>所在城市<select value={city} onChange={(e) => setCity(e.target.value)}><option>上海市</option><option>北京市</option><option>广州市</option><option>深圳市</option><option>杭州市</option><option>成都市</option></select></label>
                <label className="consent-row"><input type="checkbox" checked={precise} onChange={(e) => setPrecise(e.target.checked)} /><span><b>共享精确位置（可选）</b><small>仅用于演示附近内容，数据保存在当前设备，可随时删除。</small></span></label>
                {locationError && <div className="form-error">{locationError}</div>}
                <button className="primary" type="button" disabled={locating} onClick={requestPreciseLocation}>{locating ? "正在请求定位…" : precise ? "授权定位并进入" : "仅保存城市并进入"}</button>
                <button className="secondary" type="button" onClick={() => setGate("register")}>返回修改授权码</button>
              </div>
            )}
            {gate === "success" && (
              <div className="success-state"><span className="success-mark">✓</span><h2>同城频道已解锁</h2><p>你已完成注册。之后可以通过页首“管理数据”随时删除本机保存的信息。</p><button className="primary" onClick={() => setGate("closed")}>开始阅读</button></div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
