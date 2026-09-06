"use client";

import { useEffect, useRef, useState } from "react";
import type { ArticleVisitorList } from "../../../lib/article-management";

function time(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
}

export default function ArticleVisitors({ articleId, title, onClose, onUnauthorized }: {
  articleId: string; title: string; onClose: () => void; onUnauthorized: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<ArticleVisitorList | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(`/api/admin/articles/${encodeURIComponent(articleId)}/visitors?page=${page}`, {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw new Error("访问明细暂时无法读取，请重试。");
      const result = await response.json() as ArticleVisitorList;
      if (!controller.signal.aborted) setData(result);
    })().catch(() => {
      if (!controller.signal.aborted) setError("访问明细暂时无法读取，请重试。");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [articleId, page, revision, onUnauthorized]);
  const changePage = (value: number) => { setLoading(true); setError(""); setData(null); setPage(value); };
  return <dialog ref={dialog} className="article-visitors-dialog" aria-labelledby="article-visitors-title" onCancel={onClose}>
    <header><div><h2 id="article-visitors-title">访问明细</h2><p>{title}</p></div><button type="button" onClick={onClose} aria-label="关闭访问明细">×</button></header>
    <p className="article-visitors-note">每行代表一个匿名浏览器访客，不代表真实个人。相同编号可跨文章识别；不关联定位、IP 或账号。时间为北京时间。</p>
    {error && <p role="alert">{error} <button type="button" onClick={() => { setLoading(true); setError(""); setRevision(value => value + 1); }}>重试</button></p>}
    {loading ? <p role="status">正在加载访问明细…</p> : data && <>
      <p>访问次数（PV）：{data.viewCount} · 独立访客（UV）：{data.total}</p>
      <p className="article-visitors-note">未识别访问：{data.unidentifiedViews} 次（历史记录或隐私设置），只计入 PV，不计入 UV。</p>
      <div className="records-table-wrap"><table className="records-table article-visitors-table">
        <thead><tr><th>匿名访客编号</th><th>访问次数</th><th>首次访问</th><th>最近访问</th></tr></thead>
        <tbody>{data.visitors.map(visitor => <tr key={visitor.visitorKey}>
          <td><code title={visitor.visitorKey}>访客 {visitor.visitorKey.slice(0, 12)}</code></td><td>{visitor.viewCount}</td><td>{time(visitor.firstViewedAt)}</td><td>{time(visitor.lastViewedAt)}</td>
        </tr>)}</tbody>
      </table></div>
      {!data.visitors.length && <p>暂无可识别的匿名访客记录。</p>}
      <div className="article-list-pagination"><span>第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页</span><div>
        <button type="button" disabled={data.page <= 1} onClick={() => changePage(data.page - 1)}>上一页</button>
        <button type="button" disabled={data.page * data.pageSize >= data.total} onClick={() => changePage(data.page + 1)}>下一页</button>
      </div></div>
    </>}
  </dialog>;
}
