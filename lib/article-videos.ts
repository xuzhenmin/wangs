import { load } from "cheerio";
import { isOssArticleVideoSource } from "./article-video-urls";
import { isPrivateVideoId, PRIVATE_VIDEO_ATTRIBUTE } from "./private-video-reference";
import { getPrivateVideoAsset } from "./private-videos";

export const MAX_VIDEOS_PER_ARTICLE = 20;

export class ArticleVideoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleVideoValidationError";
  }
}

// Videos are reusable library assets rather than belonging to a single article.
// Publication/sync stores stable private resource IDs or legacy permanent OSS links.
export function privateVideoIdsFromContent(content: string): string[] {
  const $ = load(content, null, false);
  return [...new Set($("video").toArray().map(video => $(video).attr(PRIVATE_VIDEO_ATTRIBUTE)).filter(isPrivateVideoId))];
}

export function assertArticleUsesOssVideos(content: string) {
  const $ = load(content, null, false);
  const videos = $("video").toArray();
  if (videos.length > MAX_VIDEOS_PER_ARTICLE) {
    throw new ArticleVideoValidationError(`每篇文章最多插入 ${MAX_VIDEOS_PER_ARTICLE} 个视频。`);
  }
  for (const video of videos) {
    const assetId = $(video).attr(PRIVATE_VIDEO_ATTRIBUTE);
    if (assetId !== undefined) {
      if (!isPrivateVideoId(assetId) || !getPrivateVideoAsset(assetId)) {
        throw new ArticleVideoValidationError("正文包含尚未完成加密上传或未同步到本站的私密视频，请完成上传后再发布。草稿仍可保存。");
      }
      if ($(video).attr("src") || $(video).find("source[src]").length) {
        throw new ArticleVideoValidationError("私密视频不得同时引用公开地址，请从视频库重新插入。");
      }
      continue;
    }
    if (!isOssArticleVideoSource($(video).attr("src") || "")) {
      throw new ArticleVideoValidationError("正文仍有未上传 OSS 或地址无效的视频，请通过编辑器的“视频”按钮上传并插入后再发布。草稿仍可保存。");
    }
  }
}
