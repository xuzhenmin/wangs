"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type AdminLocation = {
  id: string;
  deviceId: string;
  city: string;
  address: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  consentedAt: number;
  updatedAt: number;
  expiresAt: number;
};

export default function OperationsPage() {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [locations, setLocations] = useState<AdminLocation[]>([]);
  const [selectedId, setSelectedId] = useState("");

  const loadLocations = useCallback(async () => {
    const response = await fetch("/api/admin/locations", { cache: "no-store" });
    if (response.status === 401) {
      setUnlocked(false);
      setChecking(false);
      return;
    }
    if (!response.ok) throw new Error("location-load-failed");
    const data = await response.json() as { locations: AdminLocation[] };
    setLocations(data.locations);
    setSelectedId((current) => current || data.locations[0]?.id || "");
    setUnlocked(true);
    setChecking(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      loadLocations().catch(() => {
        setChecking(false);
        setError("后台数据暂时无法读取，请稍后重试。");
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadLocations]);

  const active = locations.find((location) => location.id === selectedId) || locations[0] || null;
  const cityCount = useMemo(() => new Set(locations.map((location) => location.city)).size, [locations]);
  const averageAccuracy = useMemo(() => locations.length ? Math.round(locations.reduce((sum, location) => sum + location.accuracy, 0) / locations.length) : 0, [locations]);
  const mapUrl = useMemo(() => {
    if (!active) return "";
    const longitudeRange = 0.004;
    const latitudeRange = 0.003;
    const bbox = [active.longitude - longitudeRange, active.latitude - latitudeRange, active.longitude + longitudeRange, active.latitude + latitudeRange].join(",");
    const params = new URLSearchParams({ bbox, layer: "mapnik", marker: `${active.latitude},${active.longitude}` });
    return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
  }, [active]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setError(response.status === 401 ? "超级管理员密码不正确。" : "登录服务暂时不可用。");
      return;
    }
    setPassword("");
    await loadLocations();
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setUnlocked(false);
    setLocations([]);
    setSelectedId("");
  };

  if (checking) return <main className="ops-login"><div className="ops-login-card"><span className="ops-kicker">PRIVATE OPERATIONS</span><h1>正在验证管理员身份…</h1></div></main>;

  if (!unlocked) {
    return (
      <main className="ops-login">
        <div className="ops-login-card">
          <Link className="brand small" href="/">深<span>巷</span></Link>
          <span className="ops-kicker">SUPER ADMIN ONLY</span>
          <h1>超级管理员登录</h1>
          <p>后台包含用户明确授权上传的详细地址与精确坐标，仅限超级管理员访问。</p>
          <form onSubmit={login}>
            <label>超级管理员密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" autoComplete="current-password" /></label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit">安全登录 →</button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <aside className="ops-side">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <div className="ops-nav"><button className="current"><i>⌖</i>精确位置</button><Link href="/ops-7q4m/editor"><i>✎</i>内容管理</Link><button><i>◫</i>授权记录</button><button><i>◎</i>城市统计</button></div>
        <div className="privacy-badge"><b>超级管理员会话</b><span>位置接口已启用服务端鉴权</span></div>
        <button className="ops-exit" onClick={logout}>安全退出</button>
      </aside>

      <section className="ops-main">
        <header className="ops-head"><div><small>SUPER ADMIN / PRECISE LOCATION</small><h1>授权位置总览</h1></div><div className="ops-status"><i /> 已安全连接</div></header>
        <div className="metric-grid">
          <div><span>有效位置授权</span><b>{locations.length}</b><small>仅显示 30 天内记录</small></div>
          <div><span>覆盖城市</span><b>{cityCount}</b><small>按地址解析结果统计</small></div>
          <div><span>平均定位精度</span><b>{averageAccuracy}m</b><small>由用户设备报告</small></div>
          <div><span>数据权限</span><b>单人</b><small>仅超级管理员可读</small></div>
        </div>

        <div className="ops-grid">
          <section className="map-card">
            <div className="card-head"><div><h2>具体位置地图</h2><p>{active ? active.address : "等待用户授权位置"}</p></div><span className="consent-tag">精确坐标</span></div>
            {active ? <iframe className="precise-map" src={mapUrl} title={`${active.city}具体位置地图`} loading="lazy" /> : <div className="empty-map"><span>⌖</span><b>暂无授权位置</b><p>用户明确同意上传后，位置会显示在这里。</p></div>}
          </section>

          <aside className="record-card location-list-card">
            <div className="card-head"><div><h2>全部授权地址</h2><p>最近更新优先</p></div><span className="consent-tag">{locations.length} 条</span></div>
            <div className="location-list">
              {locations.map((location, index) => (
                <button key={location.id} className={location.id === active?.id ? "active" : ""} onClick={() => setSelectedId(location.id)}>
                  <span className="location-order">{String(index + 1).padStart(2, "0")}</span>
                  <span><b>{location.city}</b><small>{location.address}</small><em>精度约 {Math.round(location.accuracy)} 米 · {new Date(location.updatedAt).toLocaleString("zh-CN")}</em></span>
                </button>
              ))}
              {!locations.length && <p className="empty-list">暂无用户位置记录</p>}
            </div>
          </aside>
        </div>

        {active && <div className="ops-note"><b>当前坐标</b><p>{active.latitude.toFixed(6)}, {active.longitude.toFixed(6)} · {active.address} · 授权记录将在 {new Date(active.expiresAt).toLocaleDateString("zh-CN")} 到期。</p></div>}
      </section>
    </main>
  );
}
