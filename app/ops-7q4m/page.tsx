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

type AdminView = "locations" | "records" | "cities";

type CitySummary = {
  city: string;
  count: number;
  averageAccuracy: number;
  latestUpdatedAt: number;
};

const viewCopy: Record<AdminView, { eyebrow: string; title: string }> = {
  locations: { eyebrow: "SUPER ADMIN / PRECISE LOCATION", title: "授权位置总览" },
  records: { eyebrow: "SUPER ADMIN / CONSENT RECORDS", title: "授权记录" },
  cities: { eyebrow: "SUPER ADMIN / CITY ANALYTICS", title: "城市统计" },
};

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function maskDeviceId(deviceId: string) {
  if (deviceId.length <= 12) return deviceId;
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}`;
}

export default function OperationsPage() {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [locations, setLocations] = useState<AdminLocation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeView, setActiveView] = useState<AdminView>("locations");
  const [recordSearch, setRecordSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("全部城市");
  const [refreshing, setRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

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
  const cityOptions = useMemo(() => ["全部城市", ...Array.from(new Set(locations.map((location) => location.city))).sort((a, b) => a.localeCompare(b, "zh-CN"))], [locations]);
  const filteredRecords = useMemo(() => {
    const query = recordSearch.trim().toLocaleLowerCase("zh-CN");
    return locations.filter((location) => {
      if (cityFilter !== "全部城市" && location.city !== cityFilter) return false;
      if (!query) return true;
      return [location.city, location.address, location.deviceId]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
    });
  }, [cityFilter, locations, recordSearch]);
  const citySummaries = useMemo(() => {
    const summaries = new Map<string, { count: number; accuracyTotal: number; latestUpdatedAt: number }>();
    locations.forEach((location) => {
      const current = summaries.get(location.city) || { count: 0, accuracyTotal: 0, latestUpdatedAt: 0 };
      current.count += 1;
      current.accuracyTotal += location.accuracy;
      current.latestUpdatedAt = Math.max(current.latestUpdatedAt, location.updatedAt);
      summaries.set(location.city, current);
    });
    return Array.from(summaries, ([city, summary]): CitySummary => ({
      city,
      count: summary.count,
      averageAccuracy: Math.round(summary.accuracyTotal / summary.count),
      latestUpdatedAt: summary.latestUpdatedAt,
    })).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, "zh-CN"));
  }, [locations]);
  const latestUpdatedAt = locations[0]?.updatedAt || 0;
  const largestCityCount = citySummaries[0]?.count || 1;
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

  const refreshLocations = async () => {
    setRefreshing(true);
    setError("");
    try {
      await loadLocations();
    } catch {
      setError("后台数据暂时无法读取，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  };

  const revokeConsent = async (location: AdminLocation) => {
    const confirmed = window.confirm(`确定撤销该设备的位置授权吗？\n\n${location.city} · ${location.address}\n\n撤销后会删除当前记录，用户必须再次点击授权按钮才能恢复位置采集。`);
    if (!confirmed) return;
    setRevokingId(location.id);
    setError("");
    setSuccessMessage("");
    try {
      const response = await fetch(`/api/admin/locations/${location.id}`, { method: "DELETE" });
      if (response.status === 401) {
        setUnlocked(false);
        return;
      }
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `location-consent-revoke-http-${response.status}`);
      const remainingLocations = locations.filter((item) => item.id !== location.id);
      setLocations(remainingLocations);
      setSelectedId((current) => current === location.id ? remainingLocations[0]?.id || "" : current);
      setSuccessMessage("授权已撤销；该设备再次访问时需要重新点击授权确认。");
    } catch {
      setError("撤销授权失败，请刷新数据后重试。");
    } finally {
      setRevokingId("");
    }
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
    <main className="ops-shell ops-location-shell">
      <aside className="ops-side">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <div className="ops-nav">
          <button className={activeView === "locations" ? "current" : ""} onClick={() => setActiveView("locations")}><i>⌖</i>精确位置</button>
          <Link href="/ops-7q4m/editor"><i>✎</i>内容管理</Link>
          <button className={activeView === "records" ? "current" : ""} onClick={() => setActiveView("records")}><i>◫</i>授权记录</button>
          <button className={activeView === "cities" ? "current" : ""} onClick={() => setActiveView("cities")}><i>◎</i>城市统计</button>
        </div>
        <div className="privacy-badge"><b>超级管理员会话</b><span>位置接口已启用服务端鉴权</span></div>
        <button className="ops-exit" onClick={logout}>安全退出</button>
      </aside>

      <section className="ops-main">
        <header className="ops-head">
          <div><small>{viewCopy[activeView].eyebrow}</small><h1>{viewCopy[activeView].title}</h1></div>
          <div className="ops-head-actions"><div className="ops-status"><i /> 已安全连接</div><button type="button" disabled={refreshing} onClick={refreshLocations}>{refreshing ? "刷新中…" : "刷新数据"}</button></div>
        </header>
        {error && <div className="ops-inline-error" role="alert">{error}</div>}
        {successMessage && <div className="ops-inline-success" role="status">{successMessage}</div>}

        <div className="metric-grid">
          <div><span>有效授权设备</span><b>{locations.length}</b><small>仅显示服务端保留期内记录</small></div>
          <div><span>覆盖城市</span><b>{cityCount}</b><small>按地址解析结果统计</small></div>
          <div><span>平均定位精度</span><b>{averageAccuracy}m</b><small>数值越小代表越精确</small></div>
          <div><span>最近位置更新</span><b className="metric-time">{latestUpdatedAt ? formatDateTime(latestUpdatedAt).slice(5) : "暂无"}</b><small>打开新内容或每 30 分钟刷新</small></div>
        </div>

        {activeView === "locations" && (
          <>
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
                      <span><b>{location.city}</b><small>{location.address}</small><em>精度约 {Math.round(location.accuracy)} 米 · {formatDateTime(location.updatedAt)}</em></span>
                    </button>
                  ))}
                  {!locations.length && <p className="empty-list">暂无用户位置记录</p>}
                </div>
              </aside>
            </div>
            {active && <div className="ops-note"><b>当前坐标</b><p>{active.latitude.toFixed(6)}, {active.longitude.toFixed(6)} · {active.address} · 服务端记录保留至 {new Date(active.expiresAt).toLocaleDateString("zh-CN")}。</p></div>}
          </>
        )}

        {activeView === "records" && (
          <section className="ops-data-card">
            <div className="ops-data-head"><div><h2>有效授权记录</h2><p>按最近采集时间倒序排列，可搜索地址、城市或设备标识。</p></div><span className="consent-tag">{filteredRecords.length} / {locations.length} 条</span></div>
            <div className="record-filters">
              <input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="搜索城市、地址或设备标识" aria-label="搜索授权记录" />
              <select value={cityFilter} onChange={(event) => setCityFilter(event.target.value)} aria-label="按城市筛选">
                {cityOptions.map((city) => <option key={city}>{city}</option>)}
              </select>
              {(recordSearch || cityFilter !== "全部城市") && <button type="button" onClick={() => { setRecordSearch(""); setCityFilter("全部城市"); }}>清除筛选</button>}
            </div>
            <div className="records-table-wrap">
              <table className="records-table">
                <thead><tr><th>设备标识</th><th>城市与详细地址</th><th>定位精度</th><th>授权时间</th><th>最近采集</th><th>记录保留至</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {filteredRecords.map((location) => (
                    <tr key={location.id} onClick={() => { setSelectedId(location.id); setActiveView("locations"); }}>
                      <td><code title={location.deviceId}>{maskDeviceId(location.deviceId)}</code></td>
                      <td><b>{location.city}</b><small>{location.address}</small></td>
                      <td>{Math.round(location.accuracy)} 米</td>
                      <td>{formatDateTime(location.consentedAt)}</td>
                      <td>{formatDateTime(location.updatedAt)}</td>
                      <td>{formatDateTime(location.expiresAt)}</td>
                      <td><span className="record-active">有效</span></td>
                      <td>
                        <button
                          className="record-revoke"
                          type="button"
                          disabled={revokingId === location.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void revokeConsent(location);
                          }}
                        >{revokingId === location.id ? "撤销中…" : "撤销授权"}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredRecords.length && <div className="ops-data-empty">没有符合当前筛选条件的授权记录。</div>}
            </div>
          </section>
        )}

        {activeView === "cities" && (
          <section className="ops-data-card city-analytics-card">
            <div className="ops-data-head"><div><h2>城市覆盖分布</h2><p>基于当前有效授权设备统计，位置刷新后自动更新。</p></div><span className="consent-tag">{citySummaries.length} 个城市</span></div>
            <div className="city-summary-list">
              {citySummaries.map((summary, index) => {
                const percentage = locations.length ? Math.round(summary.count / locations.length * 100) : 0;
                return (
                  <article key={summary.city} className="city-summary-row">
                    <span className="city-rank">{String(index + 1).padStart(2, "0")}</span>
                    <div className="city-summary-main">
                      <div><b>{summary.city}</b><span>{summary.count} 台设备 · {percentage}%</span></div>
                      <div className="city-bar"><i style={{ width: `${summary.count / largestCityCount * 100}%` }} /></div>
                    </div>
                    <div className="city-summary-meta"><b>约 {summary.averageAccuracy} 米</b><span>平均精度</span></div>
                    <time>{formatDateTime(summary.latestUpdatedAt)}</time>
                  </article>
                );
              })}
              {!citySummaries.length && <div className="ops-data-empty">暂无可统计的城市数据。</div>}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
