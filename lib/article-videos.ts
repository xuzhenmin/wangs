import { load } from "cheerio";
import { isOssArticleVideoSource } from "./article-video-urls";

export const MAX_VIDEOS_PER_ARTICLE = 20;

export class ArticleVideoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleVideoValidationError";
  }
}

// Videos are reusable library assets rather than belonging to a single article.
// Publication/sync stores only permanent OSS links, never private admin endpoints.
export function assertArticleUsesOssVideos(content: string) {
  const $ = load(content, null, false);
  const videos = $("video").toArray();
  if (videos.length > MAX_VIDEOS_PER_ARTICLE) {
    throw new ArticleVideoValidationError(`每篇文章最多插入 ${MAX_VIDEOS_PER_ARTICLE} 个视频。`);
  }
  for (const video of videos) {
    if (!isOssArticleVideoSource($(video).attr("src") || "")) {
      throw new ArticleVideoValidationError("正文仍有未上传 OSS 或地址无效的视频，请通过编辑器的“视频”按钮上传并插入后再发布。草稿仍可保存。");
    }
  }
}
