import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import sanitizeHtml from "sanitize-html";
import { getPublishedArticle } from "../../../lib/articles";
import ArticleLocationGate from "./ArticleLocationGate";

export const dynamic = "force-dynamic";

type ArticlePageProps = { params: Promise<{ id: string }> };

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(timestamp));
}

function safeArticleContent(articleId: string, content: string) {
  const allowedImagePrefixes = [
    `/uploads/articles/${articleId}/`,
    `/article-images/${articleId}/`,
  ];

  return sanitizeHtml(content, {
    allowedTags: ["p", "br", "h1", "h2", "h3", "strong", "em", "u", "s", "code", "pre", "blockquote", "ul", "ol", "li", "hr", "a", "img"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title"],
      p: ["style"],
      h1: ["style"],
      h2: ["style"],
      h3: ["style"],
    },
    allowedStyles: { "*": { "text-align": [/^(left|center|right|justify)$/] } },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => frame.tag === "img"
      && !allowedImagePrefixes.some((prefix) => frame.attribs.src?.startsWith(prefix)),
    transformTags: {
      a: (_tagName, attribs) => {
        const external = /^https?:\/\//i.test(attribs.href || "");
        return {
          tagName: "a",
          attribs: external ? { ...attribs, target: "_blank", rel: "noreferrer noopener nofollow" } : attribs,
        };
      },
    },
  });
}

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const { id } = await params;
  const article = await getPublishedArticle(id);
  if (!article) return { title: "内容不存在｜深巷", robots: { index: false, follow: false } };
  return {
    title: `${article.title}｜深巷`,
    description: article.summary || article.title,
    openGraph: { title: `${article.title}｜深巷`, description: article.summary || article.title, type: "article" },
    twitter: { card: "summary", title: `${article.title}｜深巷`, description: article.summary || article.title },
  };
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  const article = await getPublishedArticle(id);
  if (!article) notFound();
  const content = safeArticleContent(article.id, article.content);

  return (
    <main className="published-page">
      <header className="published-header">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <Link href="/">返回首页</Link>
      </header>
      <article className="published-article">
        <span className="published-kicker">PUBLISHED ARTICLE</span>
        <h1>{article.title}</h1>
        {article.summary && <p className="published-summary">{article.summary}</p>}
        <div className="published-meta"><span>深巷内容编辑部</span><time>更新于 {formatDate(article.updatedAt)}</time></div>
        <div className="published-divider" />
        <div className="published-content" dangerouslySetInnerHTML={{ __html: content }} />
      </article>
      <footer className="published-footer"><Link className="brand small" href="/">深<span>巷</span></Link><span>内容由后台文档系统发布</span></footer>
      <ArticleLocationGate />
    </main>
  );
}
