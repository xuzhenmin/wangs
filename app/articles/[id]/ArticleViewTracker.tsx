"use client";

import { useEffect, useRef } from "react";

export default function ArticleViewTracker({ articleId }: { articleId: string }) {
  const reportedArticle = useRef<string | null>(null);
  useEffect(() => {
    if (reportedArticle.current === articleId) return;
    reportedArticle.current = articleId;
    void fetch(`/api/articles/${encodeURIComponent(articleId)}/view`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: crypto.randomUUID() }), keepalive: true,
    }).catch(() => { /* Statistics must never interrupt reading. */ });
  }, [articleId]);
  return null;
}
