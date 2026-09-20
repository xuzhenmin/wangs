"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isPrivateVideoId } from "../lib/private-video-reference";
import { articleIdFromPath, PRIVATE_VIDEO_ACCESS_EVENT } from "../lib/article-video-share-link";
import styles from "./PrivateVideoPlayer.module.css";

async function fetchAccessStatus(assetId: string, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`/api/private-videos/access?assetId=${encodeURIComponent(assetId)}`, { cache: "no-store", credentials: "same-origin", signal });
  const result = await response.json();
  if (!response.ok || typeof result.authorized !== "boolean") throw new Error(result.error || "观看权限暂时无法验证，请重试。");
  return result.authorized;
}

/** The explicit admin mode is used only by authenticated editor previews. */
export default function PrivateVideoPlayer({ assetId, title = "私密视频", admin = false }: { assetId: string; title?: string; admin?: boolean }) {
  const [access, setAccess] = useState<"checking" | "required" | "ready">(admin ? "ready" : "checking");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const resume = useRef({ assetId, time: 0 });
  const accessRequest = useRef(0);
  const needsReload = useRef(false);
  const inputId = useId();
  const valid = isPrivateVideoId(assetId);
  const manifest = `${admin ? "/api/admin/private-videos" : "/api/private-videos"}/${assetId}/manifest`;

  const checkAccess = useCallback(async (signal?: AbortSignal) => {
    if (admin) return true;
    const request = ++accessRequest.current;
    try {
      const authorized = await fetchAccessStatus(assetId, signal);
      if (signal?.aborted || request !== accessRequest.current) return null;
      setAccess(authorized ? "ready" : "required");
      return authorized;
    } catch (reason) {
      // A transient status/network error is not evidence that a valid code expired.
      if (!signal?.aborted && request === accessRequest.current) setError(reason instanceof Error ? reason.message : "网络连接失败，请重试。");
      return null;
    }
  }, [admin, assetId]);

  useEffect(() => {
    if (admin || !valid) return;
    const controller = new AbortController();
    const update = () => { void checkAccess(controller.signal).then(authorized => {
      if (authorized === true && !controller.signal.aborted) {
        setError("");
        if (needsReload.current) setAttempt(value => value + 1);
      }
    }); };
    update();
    window.addEventListener(PRIVATE_VIDEO_ACCESS_EVENT, update);
    return () => { controller.abort(); window.removeEventListener(PRIVATE_VIDEO_ACCESS_EVENT, update); };
  }, [admin, valid, checkAccess]);

  useEffect(() => {
    const element = video.current;
    if (!element || access !== "ready" || !valid) return;
    let disposed = false;
    let failed = false;
    needsReload.current = false;
    const controller = new AbortController();
    let destroy: (() => void) | undefined;
    const failure = async () => {
      if (disposed || failed) return;
      failed = true;
      needsReload.current = true;
      if (Number.isFinite(element.currentTime)) resume.current = { assetId, time: element.currentTime };
      if (admin) { setError("视频预览失败，请检查管理员登录和视频配置后重试。"); return; }
      const request = ++accessRequest.current;
      try {
        // A redirected OSS 403 can mean expired signing/CORS/storage policy, not a revoked code.
        const authorized = await fetchAccessStatus(assetId, controller.signal);
        if (disposed || request !== accessRequest.current) return;
        if (!authorized) { setAccess("required"); setError("观看权限已失效，请重新输入有效访问码。"); }
        else setError("视频资源暂时无法读取，请重试；无需重新输入访问码。");
      } catch {
        if (!disposed && request === accessRequest.current) setError("网络或观看权限验证暂时不可用，请重试；无需重新输入访问码。");
      }
    };
    const nativeFailure = () => { void failure(); };
    const restorePosition = () => {
      if (resume.current.assetId !== assetId || resume.current.time <= 0) return;
      const duration = element.duration;
      try { element.currentTime = Number.isFinite(duration) ? Math.min(resume.current.time, Math.max(0, duration - 0.1)) : resume.current.time; }
      catch { /* Some native HLS implementations report metadata before seeking is available. */ }
    };
    element.addEventListener("error", nativeFailure);
    element.addEventListener("loadedmetadata", restorePosition);
    const nativeHls = Boolean(element.canPlayType("application/vnd.apple.mpegurl"));
    // Chrome also reports "maybe", but its native HLS can reject our encrypted
    // streams. Prefer hls.js on MSE browsers; keep native playback for modern
    // WebKit (ManagedMediaSource) and native-only clients such as older iOS.
    const preferNative = nativeHls && ("ManagedMediaSource" in window || !("MediaSource" in window));
    if (preferNative) {
      // Keep native playback same-origin; no crossOrigin="use-credentials" on OSS redirects.
      element.src = manifest;
    } else {
      void import("hls.js").then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          if (nativeHls) element.src = manifest;
          else setError("当前浏览器暂不支持此视频格式，请使用新版 Safari 或 Chrome。");
          return;
        }
        const hls = new Hls();
        destroy = () => hls.destroy();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.response?.code === 401 || data.response?.code === 403 || data.fatal) { void failure(); hls.destroy(); }
        });
        hls.loadSource(manifest);
        hls.attachMedia(element);
      }).catch(() => { void failure(); });
    }
    return () => {
      disposed = true; controller.abort();
      if (!failed && Number.isFinite(element.currentTime)) resume.current = { assetId, time: element.currentTime };
      destroy?.(); element.removeEventListener("error", nativeFailure); element.removeEventListener("loadedmetadata", restorePosition);
      element.pause(); element.removeAttribute("src"); element.load();
    };
  }, [access, admin, assetId, attempt, manifest, valid]);

  async function retry() {
    setBusy(true); setError("");
    try { if (await checkAccess() === true) setAttempt(value => value + 1); }
    finally { setBusy(false); }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const articleId = articleIdFromPath(window.location.pathname);
      const response = await fetch("/api/private-videos/access", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), ...(articleId ? { articleId } : {}) }) });
      const result = await response.json();
      if (!response.ok || result.authorized !== true) throw new Error(result.error || "访问码无效或已撤销。");
      setCode(""); setAccess("ready"); window.dispatchEvent(new Event(PRIVATE_VIDEO_ACCESS_EVENT));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "网络连接失败，请重试。"); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/private-videos/access", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("退出失败，请重试。");
      setAccess("required"); window.dispatchEvent(new Event(PRIVATE_VIDEO_ACCESS_EVENT));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "网络连接失败，请重试。"); }
    finally { setBusy(false); }
  }

  if (!valid) return <p role="alert">视频资源标识无效。</p>;
  return <section className={styles.player} aria-label={title} data-private-video-player={assetId}>
    <p className={styles.title}>{title}</p>
    {access === "checking" && <p className={styles.message} role="status">正在验证观看权限…</p>}
    {access === "required" && <form className={styles.form} onSubmit={submitCode}>
      <label htmlFor={inputId}>输入访问码观看<input id={inputId} type="password" autoComplete="off" maxLength={256} required value={code} onChange={event => setCode(event.target.value)} /></label>
      <button disabled={busy}>{busy ? "正在验证…" : "确认观看"}</button>
    </form>}
    {access === "ready" && <video ref={video} controls playsInline preload="metadata" title={title} />}
    {error && <p className={`${styles.message} ${styles.error}`} role="alert">{error}</p>}
    <div className={styles.actions}>
      {error && <button type="button" disabled={busy} onClick={() => void retry()}>重试</button>}
      {!admin && access === "ready" && <button type="button" disabled={busy} onClick={() => void logout()}>退出观看</button>}
    </div>
  </section>;
}
