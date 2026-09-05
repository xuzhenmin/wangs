"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RichTextEditor, RichTextPreview } from "./RichTextEditor";

type ArticleStatus = "draft" | "published";
type EditorView = "edit" | "split" | "preview";

type Article = {
  id: string;
  title: string;
  summary: string;
  content: string;
  status: ArticleStatus;
  createdAt: number;
  updatedAt: number;
};

type Draft = Pick<Article, "title" | "summary" | "content" | "status">;

type ActiveImageImport = {
  id: string;
  articleId: string;
  uploadToken: string;
  expiresAt: number;
  requestedSources: string[];
};

type ImageImportProgress = {
  status: "waiting" | "uploading" | "completed" | "expired";
  totalImages: number;
  completedImages: number;
  failedImages: number;
};

const emptyDraft: Draft = { title: "", summary: "", content: "", status: "draft" };

function articleDraft(article: Article): Draft {
  return {
    title: article.title,
    summary: article.summary,
    content: article.content,
    status: article.status,
  };
}

function countImageSources(content: string) {
  const sources = [...content.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => (match[1] || match[2] || match[3] || "").trim());
  return {
    external: new Set(sources.filter((source) => /^https?:\/\//i.test(source))).size,
    blob: new Set(sources.filter((source) => /^blob:/i.test(source))).size,
  };
}

function getBlobImageSources(content: string) {
  return [...new Set([...content.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter((source) => /^blob:/i.test(source)))];
}

function replaceImportedImageSources(content: string, images: Array<{ sourceUrl: string; localUrl: string; status: string }>) {
  if (!images.length) return content;
  const replacements = new Map(images.filter((image) => image.status === "completed" && image.localUrl).map((image) => [image.sourceUrl, image.localUrl]));
  if (!replacements.size) return content;
  const document = new DOMParser().parseFromString(content, "text/html");
  document.querySelectorAll("img").forEach((image) => {
    const source = image.getAttribute("src") || "";
    const replacement = replacements.get(source);
    if (replacement) image.setAttribute("src", replacement);
  });
  return document.body.innerHTML;
}

function ArticlePreview({ draft }: { draft: Draft }) {
  return (
    <article className="document-preview">
      <span className="preview-status">{draft.status === "published" ? "已发布" : "草稿预览"}</span>
      <h1>{draft.title || "未命名文档"}</h1>
      {draft.summary && <p className="preview-summary">{draft.summary}</p>}
      <div className="preview-rule" />
      <div className="preview-body"><RichTextPreview content={draft.content} /></div>
    </article>
  );
}

export default function ContentEditorPage() {
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [articles, setArticles] = useState<Article[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [view, setView] = useState<EditorView>("split");
  const [savingStatus, setSavingStatus] = useState<ArticleStatus | null>(null);
  const [processingImages, setProcessingImages] = useState(false);
  const [activeImageImport, setActiveImageImport] = useState<ActiveImageImport | null>(null);
  const [imageImportProgress, setImageImportProgress] = useState<ImageImportProgress | null>(null);
  const [message, setMessage] = useState("");

  const activeArticle = useMemo(
    () => articles.find((article) => article.id === activeId) || null,
    [activeId, articles],
  );
  const dirty = useMemo(() => {
    if (!activeArticle) return Boolean(draft.title || draft.summary || draft.content);
    return JSON.stringify(articleDraft(activeArticle)) !== JSON.stringify(draft);
  }, [activeArticle, draft]);
  const imageSourceCounts = useMemo(() => countImageSources(draft.content), [draft.content]);
  const pendingImageCount = imageSourceCounts.external + imageSourceCounts.blob;

  const loadArticles = useCallback(async () => {
    const response = await fetch("/api/admin/articles", { cache: "no-store" });
    if (response.status === 401) {
      setUnlocked(false);
      setChecking(false);
      return;
    }
    if (!response.ok) throw new Error("article-load-failed");
    const data = await response.json() as { articles: Article[] };
    const selected = data.articles[0];
    setArticles(data.articles);
    setActiveId(selected?.id || "");
    setDraft(selected ? articleDraft(selected) : emptyDraft);
    setUnlocked(true);
    setChecking(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      loadArticles().catch(() => {
        setChecking(false);
        setLoginError("内容数据暂时无法读取，请稍后重试。");
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadArticles]);

  useEffect(() => {
    const documentName = draft.title.trim();
    document.title = documentName
      ? `${documentName}｜内容管理｜深巷后台`
      : "文档编辑与录入｜深巷后台";
  }, [draft.title]);

  useEffect(() => {
    if (!activeImageImport) return;
    let stopped = false;
    let timeoutId = 0;

    const poll = async () => {
      try {
        const response = await fetch(`/api/admin/articles/image-import/${activeImageImport.id}`, { cache: "no-store" });
        if (response.status === 401) {
          setUnlocked(false);
          return;
        }
        if (!response.ok) throw new Error("image-import-task-read-failed");
        const data = await response.json() as {
          task: ImageImportProgress & {
            images: Array<{ sourceUrl: string; localUrl: string; status: string; errorMessage: string }>;
          };
        };
        if (stopped) return;
        setImageImportProgress({
          status: data.task.status,
          totalImages: data.task.totalImages,
          completedImages: data.task.completedImages,
          failedImages: data.task.failedImages,
        });
        if (data.task.images.length) {
          setDraft((current) => ({ ...current, content: replaceImportedImageSources(current.content, data.task.images) }));
        }
        if (data.task.status === "completed") {
          setMessage(data.task.failedImages
            ? `Blob 图片导入完成：成功 ${data.task.completedImages} 张，失败 ${data.task.failedImages} 张；成功图片已更新到右侧预览。`
            : `${data.task.completedImages} 张 Blob 图片已导入本地，右侧预览已更新；请保存草稿或发布。`);
          return;
        }
        if (data.task.status === "expired") {
          setMessage("Blob 图片导入任务已过期，请重新点击处理按钮创建任务。");
          return;
        }
        timeoutId = window.setTimeout(() => void poll(), 1000);
      } catch {
        if (!stopped) timeoutId = window.setTimeout(() => void poll(), 2000);
      }
    };

    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeImageImport]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      setLoginError(response.status === 401 ? "超级管理员密码不正确。" : "登录服务暂时不可用。");
      return;
    }
    setPassword("");
    await loadArticles();
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setUnlocked(false);
    setArticles([]);
    setActiveId("");
    setDraft(emptyDraft);
  };

  const selectArticle = (article: Article) => {
    if (dirty && !window.confirm("当前修改尚未保存，确定切换文档吗？")) return;
    setActiveId(article.id);
    setDraft(articleDraft(article));
    setActiveImageImport(null);
    setImageImportProgress(null);
    setMessage("");
  };

  const newArticle = () => {
    if (dirty && !window.confirm("当前修改尚未保存，确定新建文档吗？")) return;
    setActiveId("");
    setDraft(emptyDraft);
    setActiveImageImport(null);
    setImageImportProgress(null);
    setMessage("");
  };

  const saveArticle = async (status: ArticleStatus) => {
    setMessage("");
    if (!draft.title.trim()) {
      setMessage("请先填写文档标题。");
      return;
    }
    const nextDraft = { ...draft, status };
    setSavingStatus(status);
    try {
      const response = await fetch(activeId ? `/api/admin/articles/${activeId}` : "/api/admin/articles", {
        method: activeId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextDraft),
      });
      if (response.status === 401) {
        setUnlocked(false);
        return;
      }
      const data = await response.json() as { article?: Article; detail?: string };
      if (!response.ok || !data.article) {
        if (response.status === 409 && data.detail) {
          setMessage(data.detail);
          return;
        }
        throw new Error("article-save-failed");
      }
      const savedArticle = data.article;
      setArticles((current) => [savedArticle, ...current.filter((article) => article.id !== savedArticle.id)]);
      setActiveId(savedArticle.id);
      setDraft(articleDraft(savedArticle));
      const savedMessage = status === "published"
        ? "内容已发布，可从左侧打开真实内容页。"
        : activeId ? "草稿修改已保存。" : "草稿已创建。";
      setMessage(savedMessage);
    } catch {
      setMessage("保存失败，请稍后重试。");
    } finally {
      setSavingStatus(null);
    }
  };

  const localizeImages = async () => {
    setMessage("");
    if (!draft.title.trim()) {
      setMessage("请先填写文档标题，再处理外链图片。");
      return;
    }
    if (!pendingImageCount) {
      setMessage("正文中没有需要处理的外链图片。");
      return;
    }

    setProcessingImages(true);
    try {
      let articleId = activeId;
      if (!articleId) {
        const draftResponse = await fetch("/api/admin/articles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, status: "draft" }),
        });
        if (draftResponse.status === 401) {
          setUnlocked(false);
          return;
        }
        const draftData = await draftResponse.json() as { article?: Article };
        if (!draftResponse.ok || !draftData.article) throw new Error("article-draft-create-failed");
        articleId = draftData.article.id;
        setArticles((current) => [draftData.article!, ...current]);
        setActiveId(articleId);
      }

      let workingContent = draft.content;
      let localizedImageCount = 0;
      if (imageSourceCounts.external) {
        const response = await fetch("/api/admin/articles/localize-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId, content: workingContent }),
        });
        if (response.status === 401) {
          setUnlocked(false);
          return;
        }
        const data = await response.json() as { content?: string; localizedImageCount?: number; detail?: string };
        if (!response.ok || typeof data.content !== "string") {
          if (response.status === 422 && data.detail) {
            setMessage(`图片处理失败：${data.detail}`);
            return;
          }
          throw new Error("image-localization-failed");
        }
        workingContent = data.content;
        localizedImageCount = data.localizedImageCount || 0;
        setDraft((current) => ({ ...current, content: workingContent }));
      }

      if (imageSourceCounts.blob) {
        const response = await fetch("/api/admin/articles/image-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId }),
        });
        if (response.status === 401) {
          setUnlocked(false);
          return;
        }
        const data = await response.json() as { task?: { id: string; uploadToken: string; expiresAt: number } };
        if (!response.ok || !data.task) throw new Error("image-import-task-create-failed");
        const task = { ...data.task, articleId, requestedSources: getBlobImageSources(workingContent) };
        setActiveImageImport(task);
        setImageImportProgress({ status: "waiting", totalImages: imageSourceCounts.blob, completedImages: 0, failedImages: 0 });
        window.dispatchEvent(new CustomEvent("shenxiang:image-import-task", {
          detail: { ...task, apiBase: window.location.origin },
        }));
        setMessage(`${localizedImageCount ? `${localizedImageCount} 张普通外链图片已处理。` : ""} Blob 导入任务已创建，请切换到原网页点击“发送图片到编辑器”。`);
      } else {
        setMessage(`${localizedImageCount} 张外链图片已下载并替换为本地地址，右侧预览已更新；请保存草稿或发布。`);
      }
    } catch {
      setMessage("图片处理失败，请稍后重试。");
    } finally {
      setProcessingImages(false);
    }
  };

  if (checking) {
    return <main className="ops-login"><div className="ops-login-card"><span className="ops-kicker">CONTENT STUDIO</span><h1>正在验证管理员身份…</h1></div></main>;
  }

  if (!unlocked) {
    return (
      <main className="ops-login">
        <div className="ops-login-card">
          <Link className="brand small" href="/">深<span>巷</span></Link>
          <span className="ops-kicker">CONTENT STUDIO</span>
          <h1>内容管理登录</h1>
          <p>新增、编辑和预览内容仅向超级管理员开放。</p>
          <form onSubmit={login}>
            <label>超级管理员密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" autoComplete="current-password" /></label>
            {loginError && <div className="form-error">{loginError}</div>}
            <button type="submit">安全登录 →</button>
          </form>
          <Link className="back-to-ops" href="/ops-7q4m">返回位置后台</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="ops-shell editor-shell">
      <aside className="ops-side">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <div className="ops-nav">
          <Link href="/ops-7q4m"><i>⌖</i>精确位置</Link>
          <Link className="current" href="/ops-7q4m/editor"><i>✎</i>内容管理</Link>
        </div>
        <div className="privacy-badge"><b>内容工作台</b><span>所有保存操作均要求管理员会话</span></div>
        <button className="ops-exit" onClick={logout}>安全退出</button>
      </aside>

      <section className="ops-main editor-main">
        <header className="ops-head editor-head">
          <div><small>SUPER ADMIN / CONTENT STUDIO</small><h1>文档编辑与录入</h1></div>
          <div className="editor-head-actions">
            <button className="editor-secondary" onClick={newArticle}>＋ 新建文档</button>
            <button className="editor-secondary editor-mobile-logout" onClick={logout}>退出</button>
          </div>
        </header>

        <div className="editor-layout">
          <aside className="document-list-card">
            <div className="card-head"><div><h2>全部文档</h2><p>按最近修改排序</p></div><span className="consent-tag">{articles.length} 篇</span></div>
            <div className="document-list">
              {articles.map((article) => (
                <div key={article.id} className={`document-list-item${article.id === activeId ? " active" : ""}`}>
                  <button className="document-select" onClick={() => selectArticle(article)}>
                    <span className={`article-state ${article.status}`}>{article.status === "published" ? "已发布" : "草稿"}</span>
                    <b>{article.title}</b>
                    <small>{article.summary || "暂无摘要"}</small>
                    <time>{new Date(article.updatedAt).toLocaleString("zh-CN")}</time>
                  </button>
                  {article.status === "published"
                    ? <Link className="document-public-link" href={`/articles/${article.id}`} target="_blank">打开内容页 <span>↗</span></Link>
                    : <span className="document-draft-note">发布后生成内容链接</span>}
                </div>
              ))}
              {!articles.length && <div className="empty-documents"><b>还没有文档</b><span>点击“新建文档”开始录入内容。</span></div>}
            </div>
          </aside>

          <form className="editor-card" onSubmit={(event) => { event.preventDefault(); void saveArticle("draft"); }}>
            <div className="editor-toolbar">
              <div>
                <span className="editing-label">{activeId ? "正在编辑" : "新建文档"}</span>
                {dirty && <em>有未保存修改</em>}
              </div>
              <div className="view-switcher" aria-label="编辑器显示方式">
                {(["edit", "split", "preview"] as EditorView[]).map((option) => (
                  <button key={option} type="button" className={view === option ? "active" : ""} onClick={() => setView(option)}>
                    {option === "edit" ? "编辑" : option === "split" ? "分屏" : "预览"}
                  </button>
                ))}
              </div>
            </div>

            <div className="editor-meta-fields">
              <label>文档标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="输入内容标题" maxLength={160} /></label>
              <div className="editor-status-field"><span>当前状态</span><b className={draft.status}>{draft.status === "published" ? "已发布" : "草稿"}</b></div>
              <label className="summary-field">内容摘要<textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="输入一段简短摘要" maxLength={500} rows={2} /></label>
            </div>

            <div className={`editor-workspace view-${view}`}>
              <section className="editor-pane input-pane">
                <div className="pane-head rich-pane-head">
                  <div><b>正文内容</b><small>普通外链直接下载；Blob 图片通过原网页导入助手回传</small></div>
                  <button
                    className="localize-images-button"
                    type="button"
                    disabled={!pendingImageCount || processingImages || savingStatus !== null}
                    onClick={() => void localizeImages()}
                  >
                    {processingImages ? "正在处理…" : pendingImageCount ? `处理待处理图片（${pendingImageCount}）` : "没有待处理图片"}
                  </button>
                </div>
                {activeImageImport && (
                  <div className="blob-import-panel">
                    <div>
                      <b>{imageImportProgress?.status === "completed" ? "Blob 导入完成" : "等待原网页发送图片"}</b>
                      <span>
                        {imageImportProgress?.status === "waiting"
                          ? "任务已就绪，创建后 10 分钟内有效"
                          : `已成功 ${imageImportProgress?.completedImages || 0} / ${imageImportProgress?.totalImages || imageSourceCounts.blob}，失败 ${imageImportProgress?.failedImages || 0}`}
                      </span>
                    </div>
                    <div className="blob-import-actions">
                      <a href="/shenxiang-blob-importer.user.js" target="_blank" rel="noreferrer">安装/更新油猴助手</a>
                      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("shenxiang:image-import-task", {
                        detail: { ...activeImageImport, apiBase: window.location.origin },
                      }))}>重新发送任务给助手</button>
                    </div>
                  </div>
                )}
                <RichTextEditor content={draft.content} onChange={(content) => setDraft((current) => ({ ...current, content }))} />
              </section>
              <section className="editor-pane preview-pane">
                <div className="pane-head"><b>处理后内容预览</b><small>图片替换结果会实时显示，但不会自动保存</small></div>
                <ArticlePreview draft={draft} />
              </section>
            </div>

            <footer className="editor-savebar">
              <span className={/失败|请先|无法|仍有/.test(message) ? "save-message error" : "save-message"}>{message}</span>
              <div className="editor-save-actions">
                <button className="save-draft-button" type="submit" disabled={savingStatus !== null || processingImages}>{savingStatus === "draft" ? "正在保存草稿…" : "保存草稿"}</button>
                <button className="publish-button" type="button" disabled={savingStatus !== null || processingImages} onClick={() => void saveArticle("published")}>{savingStatus === "published" ? "正在发布…" : draft.status === "published" ? "发布更新" : "发布内容"}</button>
              </div>
            </footer>
          </form>
        </div>
      </section>
    </main>
  );
}
