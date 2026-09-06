"use client";

import { useEffect, useState } from "react";

type Headline = { id: string; title: string };

export default function HomeHeadlines({ authorized, pending, onAuthorize }: {
  authorized: boolean; pending: boolean; onAuthorize: () => void;
}) {
  const [headlines, setHeadlines] = useState<Headline[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/articles/featured", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("headlines-unavailable");
      const data = await response.json() as { articles: Headline[] };
      if (!cancelled) setHeadlines(data.articles);
    })().catch(() => { if (!cancelled) setError(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);

  if (error) return <div className="news-empty" role="status">新闻暂时无法加载。<button onClick={() => { setError(false); setAttempt(attempt + 1); }}>重新加载</button></div>;
  if (!headlines) return <div className="news-empty" role="status">正在加载新闻标题…</div>;
  if (!headlines.length) return <p className="news-empty">暂无已发布新闻，稍后再来看看。</p>;
  return (
    <ol className="news-headlines">
      {headlines.map((item, index) => (
        <li key={item.id}>
          <span className="news-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          {authorized
            ? <a href={`/articles/${item.id}`} title={item.title}><span className="news-headline-title">{item.title}</span><span className="news-arrow" aria-hidden="true">↗</span></a>
            : <button type="button" title={item.title} onClick={onAuthorize} disabled={pending}><span className="news-headline-title">{item.title}</span><span className="news-arrow" aria-hidden="true">↗</span></button>}
        </li>
      ))}
    </ol>
  );
}
