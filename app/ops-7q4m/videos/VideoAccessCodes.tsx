"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./videos.module.css";

type AccessCode = { id: string; label: string; createdAt: number; revokedAt: number | null };

export default function VideoAccessCodes({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/admin/video-access-codes", { cache: "no-store", signal });
    if (response.status === 401) { onUnauthorized(); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "访问码列表读取失败。");
    setCodes(result.codes || []);
  }, [onUnauthorized]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) return load(controller.signal); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "网络连接失败。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/video-access-codes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label.trim() }) });
      if (response.status === 401) { onUnauthorized(); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "访问码创建失败。");
      setIssued(result.code); setLabel("");
      setCodes(current => [result.accessCode, ...current]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "网络连接失败，请先刷新列表确认是否已创建。"); }
    finally { setBusy(false); }
  }

  async function revoke(code: AccessCode) {
    if (!window.confirm(`撤销“${code.label || "未备注访问码"}”后，使用此码的所有设备都不能继续获取新的播放资源。已下载或缓冲的内容无法收回。是否继续？`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/video-access-codes/${code.id}`, { method: "DELETE" });
      if (response.status === 401) { onUnauthorized(); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "撤销失败。");
      await load(); setNotice("访问码已撤销，关联设备将不能获取新的播放资源。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "网络连接失败，请刷新列表确认状态。"); }
    finally { setBusy(false); }
  }

  return <section className={styles.card} aria-labelledby="video-access-codes-title">
    <h2 id="video-access-codes-title">私密视频访问码</h2>
    <p>每个码可观看本站全部私密视频，支持多个设备，直到你手动撤销。持有码即可观看，请仅发送给指定观看者；同步文章不会把本站访问码同步到远端。</p>
    <form className={styles.form} onSubmit={create}>
      <label>备注<input value={label} maxLength={100} placeholder="例如：发送给谁（可选）" onChange={event => setLabel(event.target.value)} /></label>
      <div><button disabled={busy || issued !== null}>生成访问码</button></div>
    </form>
    {issued && <div className={styles.issuedCode}>
      <label>新访问码（仅本次展示，请立即保存）<input readOnly value={issued} autoComplete="off" onFocus={event => event.target.select()} /></label>
      <div className={styles.actions}>
        <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(issued); setNotice("访问码已复制，请妥善保管。"); } catch { setNotice("无法自动复制，请选中访问码手动复制。"); } }}>复制访问码</button>
        <button type="button" onClick={() => setIssued(null)}>已保存，隐藏访问码</button>
      </div>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">正在读取访问码…</p>}
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { setError(""); void load().catch(reason => setError(reason instanceof Error ? reason.message : "读取失败。")); }}>刷新列表</button></div>
    {!loading && !codes.length && <p>尚未创建访问码。</p>}
    <div className={styles.codes}>{codes.map(code => <article className={styles.job} key={code.id}>
      <div className={styles.row}><h3>{code.label || "未备注访问码"}</h3><strong>{code.revokedAt ? "已撤销" : "有效"}</strong></div>
      <small>创建于 {new Date(code.createdAt).toLocaleString("zh-CN")}{code.revokedAt ? ` · 撤销于 ${new Date(code.revokedAt).toLocaleString("zh-CN")}` : " · 无自动到期时间"}</small>
      {!code.revokedAt && <button type="button" disabled={busy} onClick={() => void revoke(code)}>撤销访问码</button>}
    </article>)}</div>
  </section>;
}
