import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Article } from "./articles";
import { isOssArticleImageSource } from "./article-image-urls";

export const ARTICLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function siteOrigin() {
  const url = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://news.osfeng.cn");
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid site URL");
  return url.origin;
}

export function firstShareImage(article: Pick<Article, "id" | "content">) {
  if (!ARTICLE_UUID.test(article.id)) return "/og.png";
  const $ = load(article.content, null, false);
  for (const image of $("img").toArray()) {
    const source = $(image).attr("src")?.trim() || "";
    if (isOssArticleImageSource(article.id, source)) return source;
    for (const prefix of [`/uploads/articles/${article.id}/`, `/article-images/${article.id}/`]) {
      if (source.startsWith(prefix) && /^[0-9a-f]{24}\.(png|jpe?g|gif|webp)$/i.test(source.slice(prefix.length))) return source;
    }
  }
  return "/og.png";
}

export function articleShareData(article: Article) {
  const origin = siteOrigin();
  const version = createHash("sha256").update(`${article.updatedAt}:${firstShareImage(article)}`).digest("hex").slice(0, 16);
  return {
    title: `${article.title}｜深巷`,
    desc: article.summary || article.title,
    link: `${origin}/articles/${article.id}`,
    imgUrl: `${origin}/api/share/cover/${article.id}?v=${version}`,
  };
}
