"use client";

import { useEffect, useState } from "react";
import { isPrivateVideoId } from "../../../lib/private-video-reference";
import { parseArticleVideoShareFragment, PRIVATE_VIDEO_ACCESS_EVENT } from "../../../lib/article-video-share-link";
import styles from "./ArticleVideoShareAccess.module.css";

type Result = { state: "authorized" | "invalid" | "failed"; message: string };
type Notice = Result | { state: "none" | "checking"; message: string };
const pending = new Map<string, Promise<Result>>();
let exchangeTail: Promise<void> = Promise.resolve();
const invalid = "观看链接已失效或无权观看本文视频，请联系分享者重新获取链接。";

// Shared only while a request is in flight: StrictMode remounts subscribe to the
// same POST, but a later visit still validates server revocation and session state.
function exchangeAccess(articleId: string, code: string): Promise<Result> {
  const key = `${articleId}:${code}`;
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 32) return Promise.resolve({ state: "failed", message: "验证请求过于频繁，请稍后重试。" });
  // The first exchange creates an HttpOnly session. Serialize exchanges across
  // hash changes/client navigation so later requests include that cookie rather
  // than racing independent Set-Cookie responses and losing the current grant.
  const task = exchangeTail.then(async (): Promise<Result> => {
    try {
      const response = await fetch(`/api/articles/${articleId}/video-access`, {
        method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(15_000),
      });
      if ([400, 401, 403, 404, 410].includes(response.status)) return { state: "invalid", message: invalid };
      if (response.status === 429) return { state: "failed", message: "验证请求过于频繁，请稍后重试。" };
      if (!response.ok) return { state: "failed", message: "暂时无法验证视频观看权限，请重试。" };
      const result = await response.json();
      return result.authorized === true ? { state: "authorized", message: "" } : { state: "invalid", message: invalid };
    } catch { return { state: "failed", message: "暂时无法验证视频观看权限，请重试。" }; }
  });
  exchangeTail = task.then(() => {}, () => {});
  pending.set(key, task);
  void task.finally(() => { if (pending.get(key) === task) pending.delete(key); });
  return task;
}

/** Runs independently of article disclosure/location gates; never embeds the secret in SSR output. */
export default function ArticleVideoShareAccess({ articleId }: { articleId: string }) {
  const [notice, setNotice] = useState<Notice>({ state: "none", message: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!isPrivateVideoId(articleId)) return;
    let active = true, generation = 0;
    let currentCode: string | null | undefined;
    const update = () => {
      if (window.location.pathname.replace(/\/$/, "") !== `/articles/${articleId}`) {
        generation++; currentCode = null; setNotice({ state: "none", message: "" }); return;
      }
      const fragment = parseArticleVideoShareFragment(window.location.hash);
      if (!fragment.present || !fragment.code) {
        generation++; currentCode = null;
        setNotice(fragment.present ? { state: "invalid", message: "视频观看链接格式不正确，请联系分享者重新获取完整链接。" } : { state: "none", message: "" });
        return;
      }
      if (currentCode === fragment.code) return;
      currentCode = fragment.code;
      const request = ++generation;
      setNotice({ state: "checking", message: "正在验证视频观看权限…" });
      void exchangeAccess(articleId, fragment.code).then(result => {
        if (!active || generation !== request) return;
        setNotice(result);
        if (result.state === "authorized") window.dispatchEvent(new Event(PRIVATE_VIDEO_ACCESS_EVENT));
      });
    };
    update();
    window.addEventListener("hashchange", update);
    return () => { active = false; generation++; window.removeEventListener("hashchange", update); };
  }, [articleId, attempt]);

  if (notice.state === "none" || notice.state === "authorized") return null;
  return <aside className={styles.notice} role={notice.state === "checking" ? "status" : "alert"} aria-live="polite">
    <span>{notice.message}</span>
    {notice.state !== "checking" && <button type="button" onClick={() => setAttempt(value => value + 1)}>重新验证</button>}
  </aside>;
}
