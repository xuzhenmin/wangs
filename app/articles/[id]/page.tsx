import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import sanitizeHtml from "sanitize-html";
import { isDisplayableArticleImageSource } from "../../../lib/article-image-urls";
import { getPublishedArticle } from "../../../lib/articles";
import ArticleLocationGate from "./ArticleLocationGate";
import ArticleViewTracker from "./ArticleViewTracker";
import WechatShare from "../../WechatShare";
import { articleShareData } from "../../../lib/share-metadata";

export const dynamic = "force-dynamic";

type ArticlePageProps = { params: Promise<{ id: string }> };

function safeArticleContent(articleId: string, content: string) {
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
      && !isDisplayableArticleImageSource(articleId, frame.attribs.src || ""),
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
  const { imgUrl: shareImage, title, desc: description } = articleShareData(article);
  return {
    title,
    description,
    alternates: { canonical: `/articles/${article.id}` },
    openGraph: {
      title,
      description,
      type: "article",
      url: `/articles/${article.id}`,
      siteName: "深巷",
      locale: "zh_CN",
      publishedTime: new Date(article.createdAt).toISOString(),
      modifiedTime: new Date(article.updatedAt).toISOString(),
      images: [{ url: shareImage, width: 480, height: 480, type: "image/jpeg", alt: article.title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [shareImage],
    },
  };
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  const article = await getPublishedArticle(id);
  if (!article) notFound();
  const content = safeArticleContent(article.id, article.content);

  return (
    <main className="published-page">
      <ArticleViewTracker articleId={article.id} />
      <WechatShare {...articleShareData(article)} />
      <header className="published-header">
        <Link className="brand small" href="/">深<span>巷</span></Link>
        <Link href="/">返回首页</Link>
      </header>
      <article className="published-article">
        <span className="published-kicker">PUBLISHED ARTICLE</span>
        <h1>{article.title}</h1>
        {article.summary && <p className="published-summary">{article.summary}</p>}
        <div className="published-meta"><span>深巷内容编辑部</span></div>
        <div className="published-divider" />
        <ArticleLocationGate key={article.id} content={content} />
      </article>
      <footer className="published-footer"><Link className="brand small" href="/">深<span>巷</span></Link><span>内容由后台文档系统发布</span></footer>
    </main>
  );
}
