"use client";

import { useEffect, useRef, useState } from "react";
import type { ArticleAccessDetails } from "../../../lib/article-access";

export default function ArticleAccessSettings({ articleId, title, onClose, onSaved, onUnauthorized }: {
  articleId: string; title: string; onClose: () => void; onSaved: () => void; onUnauthorized: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [data, setData] = useState<ArticleAccessDetails | null>(null);
  const [remainingUv, setRemainingUv] = useState("10");
  const [remainingPv, setRemainingPv] = useState("");
  const [unlimitedUv, setUnlimitedUv] = useState(false);
  const [unlimitedPv, setUnlimitedPv] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(`/api/admin/articles/${encodeURIComponent(articleId)}/access`, {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error("settings-unavailable");
      const result = await response.json() as ArticleAccessDetails;
      if (controller.signal.aborted) return;
      setData(result);
      setRemainingUv(String(result.access.remainingUv ?? 10));
      setRemainingPv(String(result.access.remainingPv ?? 10));
      setUnlimitedUv(result.access.remainingUv === null);
      setUnlimitedPv(result.access.remainingPv === null);
      setStale(false);
    })().catch(() => {
      if (!controller.signal.aborted) setError("访问设置暂时无法读取，请重新加载。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [articleId, reload, onUnauthorized]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!data || savingRef.current || stale) return;
    const uv = unlimitedUv ? null : Number(remainingUv), pv = unlimitedPv ? null : Number(remainingPv);
    if ((!unlimitedUv && !remainingUv.trim()) || (!unlimitedPv && !remainingPv.trim()) ||
      [uv, pv].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000))) {
      setError("请输入 0 到 1000000000 之间的整数，或勾选不限。"); return;
    }
    savingRef.current = true; setSaving(true); setError("");
    try {
      const response = await fetch(`/api/admin/articles/${encodeURIComponent(articleId)}/access`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ remainingUv: uv, remainingPv: pv, revision: data.access.revision }),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (response.status === 409) { setStale(true); setError("设置已经变更，请重新加载后再保存。"); return; }
      if (!response.ok) throw new Error("save-failed");
      onSaved();
    } catch { setError("保存结果暂时无法确认，请重新加载核对，或重试保存。"); }
    finally { savingRef.current = false; setSaving(false); }
  }

  const willRestrict = (!unlimitedUv && remainingUv.trim() !== "" && Number(remainingUv) === 0)
    || (!unlimitedPv && remainingPv.trim() !== "" && Number(remainingPv) === 0);
  const close = () => { if (!savingRef.current) onClose(); };
  return <dialog ref={dialog} className="article-visitors-dialog article-access-settings" aria-labelledby="access-settings-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><h2 id="access-settings-title">访问量管理</h2><p>{title}</p></div><button type="button" onClick={close} disabled={saving} aria-label="关闭访问量管理">×</button></header>
    {loading ? <p role="status">正在读取访问额度…</p> : data && <form onSubmit={save}>
      <div className="article-access-summary">
        <strong className={data.access.restricted ? "article-access-locked" : "record-active"}>{data.access.restricted ? "访问受限" : "可正常访问"}</strong>
        <p>累计 UV：{data.access.usedUv - data.access.unidentifiedViews} · 累计 PV：{data.access.usedPv}</p>
        <p>剩余 UV 额度：{data.access.remainingUv ?? "不限"} · 剩余 PV 额度：{data.access.remainingPv ?? "不限"}</p>
      </div>
      <p className="article-visitors-note">设置从保存时起还可以访问的额度。UV、PV 任一额度用完后，后续打开文章的所有访客都会被限制。填写 0 会立即限制访问。</p>
      <fieldset disabled={saving || stale}>
        <legend>剩余可访问额度</legend>
        <div className="article-access-fields">
          <div><label htmlFor="access-remaining-uv">剩余可访问 UV</label>
            <input id="access-remaining-uv" type="number" min="0" max="1000000000" step="1" required={!unlimitedUv} disabled={unlimitedUv} value={remainingUv} onChange={event => setRemainingUv(event.target.value)} />
            <label className="article-access-unlimited"><input type="checkbox" checked={unlimitedUv} onChange={event => setUnlimitedUv(event.target.checked)} />UV 不限</label>
          </div>
          <div><label htmlFor="access-remaining-pv">剩余可访问 PV</label>
            <input id="access-remaining-pv" type="number" min="0" max="1000000000" step="1" required={!unlimitedPv} disabled={unlimitedPv} value={remainingPv} onChange={event => setRemainingPv(event.target.value)} />
            <label className="article-access-unlimited"><input type="checkbox" checked={unlimitedPv} onChange={event => setUnlimitedPv(event.target.checked)} />PV 不限</label>
          </div>
        </div>
      </fieldset>
      <p className="article-visitors-note">例如：已使用 10 份 UV 额度，填写剩余 UV 为 5，保存后还能接待 5 位新访客。相同访客再次打开只消耗 PV；未识别访问每次消耗 1 份 UV 额度，当前共 {data.access.unidentifiedViews} 次。</p>
      {willRestrict && <p className="article-access-warning" role="status">保存后文章将保持访问受限。要解除限制，请将启用限制的额度都设为大于 0，或勾选不限。</p>}
      <div className="article-access-form-actions"><button type="button" onClick={close} disabled={saving}>取消</button>
        <button type="submit" disabled={saving || stale}>{saving ? "保存中…" : data.access.restricted && !willRestrict ? "保存并解除限制" : "保存设置"}</button>
      </div>
    </form>}
    {error && <p className="form-error" role="alert">{error} <button type="button" disabled={saving || loading} onClick={() => { setError(""); setLoading(true); setData(null); setReload(value => value + 1); }}>重新加载</button></p>}
  </dialog>;
}
