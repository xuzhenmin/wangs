"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ArticleListResult } from "../../../lib/article-management";

function formatTime(value: number | null) {
  if (value === null) return "暂无访问";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(value);
}

export default function ArticleManagementPage() {
  const [auth, setAuth] = useState<"checking" | "required" | "ready">("checking");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<ArticleListResult | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("updated");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ q: query, status, sort, page: String(page) });
      void (async () => {
        const response = await fetch(`/api/admin/articles/list?${params}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (controller.signal.aborted) return;
        if (response.status === 401) { setAuth("required"); setData(null); return; }
        if (!response.ok) throw new Error("list-unavailable");
        const result = await response.json() as ArticleListResult;
        if (controller.signal.aborted) return;
        setData(result);
        setAuth("ready");
      })().catch(() => {
        if (!controller.signal.aborted) setError("文章列表暂时无法读取，请重试。");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [query, status, sort, page, revision]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (loggingIn) return;
    setLoggingIn(true);
    setError("");
    try {
      const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) { setError(response.status === 401 ? "密码不正确，请重试。" : "登录服务暂时不可用。"); return; }
      setPassword("");
      setAuth("checking");
      setRevision(value => value + 1);
    } catch { setError("网络连接失败，请重试。"); }
    finally { setLoggingIn(false); }
  }

  async function logout() {
    requestRef.current?.abort();
    try {
      const response = await fetch("/api/admin/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout-failed");
      setData(null); setAuth("required"); setPassword(""); setError("");
    } catch { setError("退出失败，请重试。"); }
  }

  if (auth !== "ready") return (
    <main className="ops-login"><div className="ops-login-card">
      <Link className="brand small" href="/">深<span>巷</span></Link>
      <span className="ops-kicker">ARTICLE MANAGER</span><h1>文章列表管理</h1>
      {auth === "required" ? <>
        <p>查看文章和访问统计需要超级管理员登录。</p>
        <form onSubmit={login}>
          <label>超级管理员密码<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" disabled={loggingIn}>{loggingIn ? "登录中…" : "安全登录 →"}</button>
        </form>
      </> : <>
        <p role="status">{error || "正在验证管理员会话…"}</p>
        {error && <button type="button" className="editor-secondary" onClick={() => setRevision(value => value + 1)}>重新加载</button>}
      </>}
    </div></main>
  );

  return (
    <main className="ops-shell ops-location-shell article-manager-shell">
      <aside className="ops-side">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <nav className="ops-nav" aria-label="后台管理">
          <Link href="/ops-7q4m"><i>⌖</i>精确位置</Link>
          <Link href="/ops-7q4m/editor"><i>✎</i>内容管理</Link>
          <Link className="current" aria-current="page" href="/ops-7q4m/articles"><i>▤</i>文章列表管理</Link>
        </nav>
        <div className="privacy-badge"><b>文章与访问统计</b><span>仅超级管理员可查看</span></div>
        <button className="ops-exit" onClick={logout}>安全退出</button>
      </aside>
      <section className="ops-main">
        <header className="ops-head">
          <div><small>SUPER ADMIN / ARTICLES</small><h1>文章列表管理</h1></div>
          <div className="ops-head-actions">
            <Link className="editor-secondary" href="/ops-7q4m/editor">内容编辑</Link>
            <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? "刷新中…" : "刷新列表"}</button>
            <button className="article-manager-mobile-logout" type="button" onClick={logout}>退出</button>
          </div>
        </header>
        {error && <p className="ops-inline-error" role="alert">{error}</p>}
        <div className="metric-grid">
          <div><span>全部文章</span><b>{data?.stats.total ?? 0}</b><small>包含草稿和已发布文章</small></div>
          <div><span>已发布</span><b>{data?.stats.published ?? 0}</b><small>可通过内容链接访问</small></div>
          <div><span>草稿</span><b>{data?.stats.drafts ?? 0}</b><small>尚未对外发布</small></div>
          <div><span>累计访问次数（PV）</span><b>{(data?.stats.views ?? 0).toLocaleString("zh-CN")}</b><small>本站文章页面访问累计</small></div>
        </div>
        <section className="ops-data-card">
          <div className="ops-data-head"><div><h2>全部文章</h2><p>时间均为北京时间；访问统计从此功能上线后开始累计。</p></div></div>
          <form className="article-list-filters" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search); }}>
            <input aria-label="搜索文章标题" placeholder="搜索文章标题" value={search} maxLength={160} onChange={event => setSearch(event.target.value)} />
            <select aria-label="文章状态" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option></select>
            <select aria-label="排序方式" value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="updated">最近修改优先</option><option value="created">最新创建优先</option><option value="views">访问最多优先</option></select>
            <button type="submit">搜索</button>
          </form>
          <div className="records-table-wrap" aria-busy={loading}>
            <table className="records-table article-management-table">
              <thead><tr><th scope="col">文章标题</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">修改时间</th><th scope="col">访问次数</th><th scope="col">最近访问</th><th scope="col">操作</th></tr></thead>
              <tbody>{data?.articles.map(article => <tr key={article.id}>
                <td className="article-list-title"><b>{article.title}</b><small>{article.id}</small></td>
                <td><span className={article.status === "published" ? "record-active" : "article-draft-tag"}>{article.status === "published" ? "已发布" : "草稿"}</span></td>
                <td>{formatTime(article.createdAt)}</td><td>{formatTime(article.updatedAt)}</td>
                <td className="article-view-count">{article.viewCount.toLocaleString("zh-CN")}</td><td>{formatTime(article.lastViewedAt)}</td>
                <td><div className="article-list-actions"><Link href={`/ops-7q4m/editor?id=${encodeURIComponent(article.id)}`}>编辑</Link>{article.status === "published" && <a href={`/articles/${article.id}`} target="_blank" rel="noopener noreferrer">查看文章 ↗</a>}</div></td>
              </tr>)}</tbody>
            </table>
            {!data?.articles.length && <p className="ops-data-empty">{loading ? "正在加载…" : "暂无符合条件的文章"}</p>}
          </div>
          <div className="article-list-pagination">
            <span role="status">共 {data?.total ?? 0} 篇 · 第 {data?.page ?? 1} / {Math.max(1, Math.ceil((data?.total ?? 0) / 20))} 页</span>
            <div><button disabled={loading || (data?.page ?? 1) <= 1} onClick={() => setPage((data?.page ?? 1) - 1)}>上一页</button><button disabled={loading || !data || data.page * data.pageSize >= data.total} onClick={() => setPage((data?.page ?? 1) + 1)}>下一页</button></div>
          </div>
        </section>
        <p className="article-list-note">PV 按文章页面打开次数统计，刷新或重新打开会增加；不是独立访客数。后台编辑预览、链接预加载不计入，各部署环境分别累计。</p>
      </section>
    </main>
  );
}
