"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { VideoJob } from "../../../lib/video-imports.mjs";
import { isArticleVideoUrl } from "./ArticleVideo";
import styles from "./VideoPicker.module.css";

type Library = {
  jobs: VideoJob[];
  oss: { ready: boolean; message: string };
  articleVideoBaseUrl: string | null;
};

export function VideoPicker({ onClose, onInsert, articleVideoBaseUrl }: {
  onClose: () => void;
  onInsert: (video: { src: string; title: string }) => string | void;
  articleVideoBaseUrl?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestScope = useRef<AbortController | null>(null);
  const loadingSequence = useRef(0);
  const titleId = useId();
  const introId = useId();
  const [library, setLibrary] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const sequence = ++loadingSequence.current;
    const response = await fetch("/api/admin/video-imports", { cache: "no-store", signal });
    const result = await response.json();
    if (signal.aborted || sequence !== loadingSequence.current) return;
    if (response.status === 401) {
      setAuthRequired(true); setLibrary(null); setPreview(null);
      throw new Error("管理员登录已失效，请重新登录后打开视频库。");
    }
    if (!response.ok) throw new Error(result.error || "视频库读取失败，请重试。");
    setAuthRequired(false);
    setLibrary({ jobs: result.jobs || [], oss: result.oss || { ready: false, message: "本站尚未配置 OSS 视频上传。" }, articleVideoBaseUrl: result.articleVideoBaseUrl || null });
    setLoadError("");
  }, []);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    requestScope.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try { if (!document.hidden) await load(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "网络连接失败，请重试。"); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer); requestScope.current = null;
      element?.close();
    };
  }, [load]);

  async function upload(job: VideoJob) {
    if (!window.confirm(`将“${job.title || "未命名视频"}”上传至本站 OSS 后，持有视频地址的任何人均可访问。请确认有权公开此视频。上传不会自动保存或发布文章。是否继续？`)) return;
    const controller = requestScope.current;
    if (!controller || controller.signal.aborted) return;
    setUploading(job.id); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/video-imports/${job.id}/oss`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorized: true }), signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 401) { setAuthRequired(true); setLibrary(null); setPreview(null); }
      if (!response.ok) throw new Error(result.error || "视频上传失败。");
      if (result.job) setLibrary(current => current ? { ...current, jobs: current.jobs.map(item => item.id === job.id ? result.job : item) } : current);
      setNotice("上传任务已提交。上传完成后，点击“插入正文”放入当前光标处。");
      await load(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "网络连接失败，上传请求可能已被服务接收，请刷新状态确认后再重试。");
    } finally { if (!controller.signal.aborted) setUploading(null); }
  }

  const jobs = library?.jobs.filter(job => job.status === "completed") || [];
  const base = articleVideoBaseUrl || library?.articleVideoBaseUrl;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={introId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}><h2 id={titleId}>插入视频</h2><button autoFocus type="button" className={styles.close} aria-label="关闭视频库" onClick={onClose}>×</button></header>
    <p className={styles.intro} id={introId}>选择已处理的视频，上传至 OSS 后插入正文。视频将在当前光标位置插入，并同步显示在右侧预览；保存草稿或发布文章仍需手动操作。</p>
    <a href="/ops-7q4m/videos" target="_blank" rel="noopener noreferrer">打开视频处理页（新标签页）</a>
    <p className={styles.intro}>可在新标签页生成配对码、导入 HLS 视频；完成后回到此处，列表每 4 秒自动刷新。当前编辑内容不会因此丢失。</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {loadError && <p className={styles.error} role="alert">{loadError}</p>}
    {authRequired && <p className={styles.notice}><a href="/ops-7q4m/videos" target="_blank" rel="noopener noreferrer">前往后台重新登录</a>，完成后关闭并重新打开视频库。</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {!library && !authRequired && !loadError && <p className={styles.notice} role="status">正在读取视频库…</p>}
    {loadError && !authRequired && <button type="button" className={styles.retry} onClick={() => {
      const controller = requestScope.current;
      if (controller) void load(controller.signal).catch(reason => { if (!controller.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "网络连接失败。"); });
    }}>重新读取</button>}
    {library && !library.oss.ready && <p className={styles.error} role="alert">{library.oss.message || "本站尚未配置 OSS 视频上传。"}</p>}
    {library && !jobs.length && <p className={styles.notice}>还没有处理完成的视频。请先打开视频处理页，完成视频下载和校验。</p>}
    <div className={styles.jobs}>{jobs.map(job => {
      const publication = job.publication;
      const published = publication?.status === "uploaded";
      const transferring = publication?.status === "uploading";
      const validSource = published && isArticleVideoUrl(publication.url, base);
      const progress = Math.max(0, Math.min(100, Math.round(publication?.progress || 0)));
      return <article className={styles.job} key={job.id}>
        <div className={styles.row}><h3>{job.title || "未命名视频"}</h3><span className={styles.status}>{published ? "已上传 OSS" : transferring ? `上传中 ${progress}%` : publication?.status === "failed" ? "上传失败" : "仅本地保存"}</span></div>
        <small className={styles.meta}>{(Number(job.fileBytes || job.bytes || 0) / 1024 / 1024).toFixed(1)} MiB{job.duration ? ` · ${Math.round(job.duration)} 秒` : ""}</small>
        {transferring && <progress className={styles.progress} aria-label={`${job.title || "视频"}的 OSS 上传进度`} max={100} value={progress} />}
        {publication?.error && <p className={styles.error}>{publication.error}</p>}
        {published && !validSource && <p className={styles.error}>此视频地址与本站当前 OSS 配置不匹配，暂不能插入；请在视频处理页重新上传。</p>}
        <div className={styles.actions}>
          <button type="button" onClick={() => setPreview(current => current === job.id ? null : job.id)}>{preview === job.id ? "关闭预览" : "预览本地视频"}</button>
          {(!published || !validSource) && <button type="button" disabled={!library?.oss.ready || transferring || uploading !== null || authRequired} onClick={() => void upload(job)}>{uploading === job.id ? "正在提交…" : transferring ? "正在上传…" : published ? "按当前配置重新上传 OSS" : publication?.status === "failed" ? "重试上传 OSS" : "上传至 OSS"}</button>}
          <button type="button" className={styles.primary} disabled={!validSource || authRequired} onClick={() => {
            if (!publication?.url || !isArticleVideoUrl(publication.url, base)) return;
            const insertError = onInsert({ src: publication.url, title: job.title || "视频" });
            if (insertError) setError(insertError); else onClose();
          }}>插入正文</button>
          {validSource && <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(publication!.url!); setNotice("OSS 视频地址已复制。"); }
            catch { setError("浏览器未允许复制，请在视频处理页查看视频地址。"); }
          }}>复制地址</button>}
        </div>
        {preview === job.id && <video key={job.id} className={styles.preview} controls playsInline preload="metadata" src={`/api/admin/video-imports/${job.id}/file`} title={job.title || "视频预览"} />}
      </article>;
    })}</div>
    <p className={styles.footer}>只有明确确认后才会上传，上传的视频可通过 OSS 地址公开访问。关闭窗口不会取消已提交的上传任务。</p>
  </dialog>;
}
