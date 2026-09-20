"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./ArticleVideoShare.module.css";

type ArticleShare = { code: string | null; sharePath: string | null; createdAt: number; revokedAt: number | null };
type ShareResult = { share: ArticleShare | null; hasPrivateVideos: boolean };
type ShareAction = "ensure" | "rotate" | "revoke";

/** Do not copy an arbitrary URL or move the bearer secret into query parameters. */
export function articleVideoShareUrl(articleId: string, share: ArticleShare | null, origin: string) {
  if (!share || share.revokedAt !== null || typeof share.code !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(share.code) || typeof share.sharePath !== "string") return null;
  try {
    const url = new URL(share.sharePath, origin);
    if (url.origin !== origin || url.pathname !== `/articles/${encodeURIComponent(articleId)}` || url.search || url.username || url.password || url.hash !== `#video-access=${encodeURIComponent(share.code)}`) return null;
    return url.href;
  } catch { return null; }
}

export default function ArticleVideoShare({ articleId, title, copyOnLoad = false, onClose, onUnauthorized }: {
  articleId: string; title: string; copyOnLoad?: boolean; onClose: () => void; onUnauthorized: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scope = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const busyRef = useRef(false);
  const titleId = useId();
  const introId = useId();
  const [data, setData] = useState<ShareResult | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const copy = useCallback(async (value: string, type: "code" | "link", signal: AbortSignal, sequence: number) => {
    if (signal.aborted || sequence !== requestSequence.current) return;
    try {
      await navigator.clipboard.writeText(value);
      if (!signal.aborted && sequence === requestSequence.current) setNotice(type === "link" ? "分享链接已复制，请仅发送给获准观看此文章视频的人。" : "访问码已复制，请妥善保管。");
    } catch {
      if (!signal.aborted && sequence === requestSequence.current) setNotice("浏览器未允许自动复制，请选中对应输入框中的内容，手动复制。");
    }
  }, []);

  const request = useCallback(async (action: ShareAction, automaticCopy = false) => {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || busyRef.current) return;
    const sequence = ++requestSequence.current;
    busyRef.current = true; setBusy(true); setError(""); setNotice(""); setData(null); setShareUrl(null);
    try {
      const response = await fetch(`/api/admin/articles/${encodeURIComponent(articleId)}/video-share`, {
        method: action === "revoke" ? "DELETE" : "POST", cache: "no-store", credentials: "same-origin",
        headers: action === "revoke" ? undefined : { "Content-Type": "application/json" },
        body: action === "revoke" ? undefined : JSON.stringify({ action }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      if (response.status === 401) { setData(null); setShareUrl(null); onUnauthorized(); return; }
      const result = await response.json();
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      if (!response.ok) throw new Error(result.error || "文章视频分享设置暂时不可用。");
      if (typeof result.hasPrivateVideos !== "boolean" || (result.hasPrivateVideos && (!result.share || !Number.isSafeInteger(result.share.createdAt) || result.share.createdAt <= 0 || (result.share.revokedAt !== null && (!Number.isSafeInteger(result.share.revokedAt) || result.share.revokedAt <= 0))))) throw new Error("文章视频分享数据无效，请重新读取。");
      const next = result as ShareResult;
      const url = articleVideoShareUrl(articleId, next.share, window.location.origin);
      if (next.hasPrivateVideos && next.share?.revokedAt === null && !url) throw new Error("分享链接格式无效，请重新读取；不会复制不安全的地址。");
      setData(next); setShareUrl(url);
      if (action === "rotate") setNotice("访问码已重置。旧码、旧分享链接及其观看授权已失效，请重新发送当前分享链接。");
      if (action === "revoke") setNotice("本文章的视频分享已停用，不会影响其他文章的独立分享码。");
      if (automaticCopy && url) await copy(url, "link", controller.signal, sequence);
    } catch (reason) {
      if (!controller.signal.aborted && sequence === requestSequence.current) setError(action === "ensure"
        ? reason instanceof Error ? reason.message : "网络连接失败，请重新读取。"
        : "操作结果暂时无法确认，请重新读取核对。不会自动重试重置或停用操作。");
    } finally {
      if (!controller.signal.aborted && sequence === requestSequence.current) { busyRef.current = false; setBusy(false); }
    }
  }, [articleId, copy, onUnauthorized]);

  useEffect(() => {
    const element = dialog.current;
    const controller = new AbortController(); scope.current = controller;
    element?.showModal();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) return request("ensure", copyOnLoad); });
    return () => { controller.abort(); requestSequence.current += 1; busyRef.current = false; scope.current = null; element?.close(); };
  }, [copyOnLoad, request]);

  const close = () => {
    scope.current?.abort(); requestSequence.current += 1;
    setData(null); setShareUrl(null); setNotice(""); setError("");
    onClose();
  };
  const revoked = data?.share?.revokedAt !== null && data?.share?.revokedAt !== undefined;
  const copyCurrent = (type: "code" | "link") => {
    const value = type === "code" ? data?.share?.code : shareUrl;
    const controller = scope.current;
    if (!busyRef.current && value && controller) void copy(value, type, controller.signal, requestSequence.current);
  };
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={introId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className={styles.header}><div><h2 id={titleId}>文章视频分享</h2><p>{title}</p></div><button className={styles.close} autoFocus type="button" onClick={close} aria-label="关闭文章视频分享">×</button></header>
    <p id={introId} className={styles.description}>持有此分享链接或访问码的人，可以观看本文章中的私密视频，不会解锁其他文章。文章原有访问额度、定位及内容展示规则不变。</p>
    {busy && <p className={styles.status} role="status">正在读取或更新分享设置…</p>}
    {data && !data.hasPrivateVideos && <p className={styles.status}>此文章当前没有私密视频，无需视频访问码。</p>}
    {revoked && <p className={styles.revoked}>本文章的视频分享已停用。重新打开本窗口不会恢复分享；如需恢复，请点击“重置访问码”生成新码。</p>}
    {data?.hasPrivateVideos && data.share && !revoked && shareUrl && <div className={styles.fields}>
      <label className={styles.field}>本文章访问码<input readOnly autoComplete="off" value={data.share.code || ""} onFocus={event => event.target.select()} /></label>
      <label className={styles.field}>分享链接<input readOnly autoComplete="off" value={shareUrl} onFocus={event => event.target.select()} /></label>
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => copyCurrent("code")}>复制访问码</button><button type="button" disabled={busy} onClick={() => copyCurrent("link")}>复制分享链接</button></div>
      <p className={styles.status}>创建于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(data.share.createdAt)}。重新查看不会更改此码。</p>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void request("ensure")}>重新读取</button><button type="button" onClick={close}>关闭</button></div>
    {data?.hasPrivateVideos && <div className={`${styles.actions} ${styles.destructive}`}>
      <button type="button" disabled={busy} onClick={() => { if (window.confirm("重置后，旧访问码、旧分享链接及其观看授权将失效，并生成本文章的新码。已下载或缓冲的内容无法收回。确定重置？")) void request("rotate"); }}>重置访问码</button>
      {!revoked && <button type="button" disabled={busy} onClick={() => { if (window.confirm("停用后，此文章分享码及其观看授权将失效；重新查看不会恢复。已下载或缓冲的内容无法收回。确定停用分享？")) void request("revoke"); }}>停用分享</button>}
    </div>}
  </dialog>;
}
