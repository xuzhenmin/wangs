"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ArticleLocationGate from "./ArticleLocationGate";

type State = { status: "loading" | "restricted" | "error" | "missing"; content?: never } | { status: "ready"; content: string };

export default function ArticleAccessGate({ articleId }: { articleId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const event = useRef<{ articleId: string; id: string } | null>(null);
  const pending = useRef<{ articleId: string; attempt: number; promise: Promise<State> } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    if (!event.current || event.current.articleId !== articleId) event.current = { articleId, id: crypto.randomUUID() };
    if (!pending.current || pending.current.articleId !== articleId || pending.current.attempt !== attempt) {
      const promise = (async (): Promise<State> => {
        const response = await fetch(`/api/articles/${encodeURIComponent(articleId)}/view`, {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: event.current!.id }),
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 403) return { status: "restricted" };
        if (response.status === 404) return { status: "missing" };
        if (!response.ok) throw new Error("access-unavailable");
        const result = await response.json() as { content?: unknown };
        if (typeof result.content !== "string") throw new Error("invalid-content");
        return { status: "ready", content: result.content };
      })().catch((): State => ({ status: "error" }));
      // Strict Mode reuses the same in-flight request and event, including the
      // first visit before the browser has received its visitor cookie.
      pending.current = { articleId, attempt, promise };
    }
    void pending.current.promise.then(result => { if (active) setState(result); });
    return () => { active = false; };
  }, [articleId, attempt]);

  useEffect(() => {
    if (state.status !== "restricted") return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [state.status]);

  function retry() {
    if (state.status === "restricted") event.current = null;
    setState({ status: "loading" });
    setAttempt(value => value + 1);
  }

  if (state.status === "ready") return <ArticleLocationGate key={articleId} content={state.content} />;
  return <section className="article-access-status" aria-live="polite">
    {state.status === "loading" && <p role="status">正在加载文章…</p>}
    {state.status === "error" && <><p role="alert">文章暂时无法加载，请重试。</p><button type="button" onClick={retry}>重新加载</button></>}
    {state.status === "missing" && <><p>文章不存在或已下架。</p><Link href="/">返回首页</Link></>}
    {state.status === "restricted" && <>
      <p>访问受限，请等待管理员解除限制后重试。</p>
      <button type="button" onClick={retry}>重新尝试访问</button>
      <dialog ref={dialog} className="article-access-restricted" aria-labelledby="article-access-title">
        <span className="published-kicker">深巷</span>
        <h2 id="article-access-title">访问受限</h2>
        <p>这篇文章的访问额度已用完。请等待管理员解除限制后，再尝试访问。</p>
        <div><button type="button" onClick={retry}>重新尝试访问</button><Link href="/">返回首页</Link></div>
      </dialog>
    </>}
  </section>;
}
