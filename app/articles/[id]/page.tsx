import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublishedArticle } from "../../../lib/articles";
import ArticleAccessGate from "./ArticleAccessGate";
import WechatShare from "../../WechatShare";
import BackToTop from "../../BackToTop";
import { articleShareData } from "../../../lib/share-metadata";

export const dynamic = "force-dynamic";

type ArticlePageProps = { params: Promise<{ id: string }> };

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

  return (
    <main className="published-page">
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
        <ArticleAccessGate key={article.id} articleId={article.id} />
      </article>
      <footer className="published-footer"><Link className="brand small" href="/">深<span>巷</span></Link></footer>
      <BackToTop />
    </main>
  );
}
