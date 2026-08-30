"use client";

import { useEffect, useMemo, useState } from "react";

type LocalRecord = {
  city?: string;
  precision?: "city" | "precise";
  latitude?: number;
  longitude?: number;
  consentedAt?: string;
};

const demoUsers = [
  { id: "U-2048", city: "上海市 · 静安区", x: 61, y: 38, precision: "城市级", time: "21:42" },
  { id: "U-1831", city: "上海市 · 徐汇区", x: 43, y: 66, precision: "城市级", time: "21:17" },
  { id: "U-1726", city: "上海市 · 杨浦区", x: 77, y: 25, precision: "主动共享", time: "20:56" },
  { id: "U-1609", city: "上海市 · 浦东新区", x: 83, y: 57, precision: "城市级", time: "20:31" },
];

export default function OperationsPage() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [localRecord, setLocalRecord] = useState<LocalRecord | null>(null);
  const [selected, setSelected] = useState("U-1726");

  useEffect(() => {
    try {
      const raw = localStorage.getItem("shenxiang_location");
      if (raw) setLocalRecord(JSON.parse(raw));
    } catch { /* ignore malformed local demo state */ }
  }, []);

  const records = useMemo(() => {
    if (!localRecord) return demoUsers;
    return [
      ...demoUsers,
      {
        id: "LOCAL",
        city: localRecord.city || "未标注城市",
        x: 52,
        y: 48,
        precision: localRecord.precision === "precise" ? "本机主动共享" : "城市级",
        time: "刚刚",
      },
    ];
  }, [localRecord]);

  const active = records.find((record) => record.id === selected) || records[0];

  const login = (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== "OPS-0830") {
      setError("访问码不正确。演示访问码为 OPS-0830");
      return;
    }
    setUnlocked(true);
    setError("");
  };

  if (!unlocked) {
    return (
      <main className="ops-login">
        <div className="ops-login-card">
          <a className="brand small" href="/">深<span>巷</span></a>
          <span className="ops-kicker">PRIVATE OPERATIONS</span>
          <h1>位置数据控制台</h1>
          <p>该演示后台仅显示匿名化数据，以及用户在当前设备上明确同意分享的位置。正式上线需替换为服务端身份认证。</p>
          <form onSubmit={login}>
            <label>后台访问码<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入访问码" /></label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit">进入控制台 →</button>
            <small>演示访问码：OPS-0830</small>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <aside className="ops-side">
        <a className="brand small" href="/">深<span>巷</span></a>
        <div className="ops-nav">
          <button className="current"><i>⌖</i>位置概览</button>
          <button><i>◫</i>授权记录</button>
          <button><i>◎</i>城市统计</button>
          <button><i>⚙</i>隐私设置</button>
        </div>
        <div className="privacy-badge"><b>隐私保护开启</b><span>默认模糊化至城市级</span></div>
        <button className="ops-exit" onClick={() => setUnlocked(false)}>退出控制台</button>
      </aside>

      <section className="ops-main">
        <header className="ops-head"><div><small>OPERATIONS / LOCATION</small><h1>同城授权概览</h1></div><div className="ops-status"><i /> 数据已同步 <span>21:48</span></div></header>

        <div className="metric-grid">
          <div><span>今日活跃授权</span><b>1,284</b><small>↑ 8.4% 较昨日</small></div>
          <div><span>城市级位置</span><b>92.7%</b><small>默认隐私范围</small></div>
          <div><span>主动共享精确位置</span><b>7.3%</b><small>需单独明确同意</small></div>
          <div><span>24 小时撤回</span><b>36</b><small>已自动删除</small></div>
        </div>

        <div className="ops-grid">
          <section className="map-card">
            <div className="card-head"><div><h2>实时位置分布</h2><p>圆点为隐私偏移后的示意位置，并非真实门牌坐标</p></div><button>上海市⌄</button></div>
            <div className="map-canvas">
              <div className="river r1" /><div className="river r2" />
              {[18,33,52,68,84].map((n) => <i className="road horizontal" style={{ top: `${n}%` }} key={`h${n}`} />)}
              {[14,29,47,64,79,91].map((n) => <i className="road vertical" style={{ left: `${n}%` }} key={`v${n}`} />)}
              <span className="district d1">静安</span><span className="district d2">徐汇</span><span className="district d3">杨浦</span><span className="district d4">浦东</span>
              {records.map((record) => <button key={record.id} onClick={() => setSelected(record.id)} className={`map-pin ${record.id === selected ? "selected" : ""}`} style={{ left: `${record.x}%`, top: `${record.y}%` }} aria-label={`查看 ${record.id}`}><i /><span>{record.id}</span></button>)}
              <div className="map-legend"><span><i className="city-dot" />城市级</span><span><i className="precise-dot" />主动共享</span></div>
            </div>
          </section>

          <aside className="record-card">
            <div className="card-head"><div><h2>授权详情</h2><p>匿名用户标识</p></div><span className="consent-tag">有效授权</span></div>
            <div className="record-avatar">{active.id === "LOCAL" ? "本" : active.id.slice(-2)}</div>
            <h3>{active.id}</h3><p className="record-city">{active.city}</p>
            <dl><div><dt>共享精度</dt><dd>{active.precision}</dd></div><div><dt>最近活跃</dt><dd>今天 {active.time}</dd></div><div><dt>用途</dt><dd>同城内容推荐</dd></div><div><dt>保留期限</dt><dd>最长 30 天</dd></div></dl>
            {active.id === "LOCAL" && localRecord?.precision === "precise" && <div className="coord-box"><small>仅本机演示坐标</small><b>{localRecord.latitude?.toFixed(4)}, {localRecord.longitude?.toFixed(4)}</b></div>}
            <button className="delete-record" onClick={() => { localStorage.removeItem("shenxiang_location"); setLocalRecord(null); setSelected("U-1726"); }}>撤回并删除本机记录</button>
          </aside>
        </div>

        <div className="ops-note"><b>数据边界</b><p>此版本为隐私安全原型：不向服务器上传真实定位。后台中的常规点位是匿名演示数据；标记为 LOCAL 的记录仅来自当前浏览器，关闭或清除数据后即消失。</p></div>
      </section>
    </main>
  );
}
