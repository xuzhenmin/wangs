import { getDb } from "../db";
import { accessFromUsage, type ArticleAccess } from "./article-access";
import type { ArticleVisitorRegion } from "./article-visitor-region";

export type ManagedArticle = {
  id: string; title: string; status: "draft" | "published";
  createdAt: number; updatedAt: number; viewCount: number; visitorCount: number; lastViewedAt: number | null;
  access: ArticleAccess;
};
export type ArticleListResult = {
  articles: ManagedArticle[]; total: number; page: number; pageSize: number;
  stats: { total: number; published: number; drafts: number; views: number; visitors: number };
};

export function listManagedArticles(params: URLSearchParams): ArticleListResult {
  const db = getDb();
  const query = (params.get("q") || "").trim().slice(0, 160);
  const status = params.get("status") || "all";
  const sort = params.get("sort") || "updated";
  const order = sort === "created" ? "a.created_at" : sort === "views" ? "viewCount" : sort === "visitors" ? "visitorCount" : "a.updated_at";
  const pageSize = 20;
  const requested = Number(params.get("page") || 1);
  const filter = "(? = '' OR instr(lower(a.title), lower(?)) > 0) AND (? = 'all' OR a.status = ?)";
  const selectedStatus = status === "draft" || status === "published" ? status : "all";
  const values = [query, query, selectedStatus, selectedStatus];
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM articles a WHERE ${filter}`).get(...values) as { total: number };
  const page = Math.min(Math.max(1, Number.isSafeInteger(requested) ? requested : 1), Math.max(1, Math.ceil(total / pageSize)));
  const articles = db.prepare(`SELECT a.id, a.title, a.status,
    a.created_at AS createdAt, a.updated_at AS updatedAt,
    COALESCE(v.views, 0) AS viewCount, COALESCE(v.visitors, 0) AS visitorCount, v.latest AS lastViewedAt,
    COALESCE(v.unidentified, 0) AS unidentified,
    CASE WHEN p.article_id IS NULL THEN 10 ELSE p.uv_limit END AS uvLimit,
    p.pv_limit AS pvLimit, COALESCE(p.revision, 0) AS revision
    FROM articles a LEFT JOIN (
      SELECT article_id, COUNT(*) AS views, COUNT(DISTINCT visitor_key) AS visitors, MAX(visited_at) AS latest,
        COUNT(*) - COUNT(visitor_key) AS unidentified
      FROM article_view_events GROUP BY article_id
    ) v ON v.article_id = a.id
    LEFT JOIN article_access_policies p ON p.article_id = a.id
    WHERE ${filter} ORDER BY ${order} DESC, a.id ASC LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize) as (Omit<ManagedArticle, "access"> & {
    unidentified: number; uvLimit: number | null; pvLimit: number | null; revision: number;
  })[];
  const stats = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status = 'published'), 0) AS published,
    COALESCE(SUM(status = 'draft'), 0) AS drafts,
    (SELECT COUNT(*) FROM article_view_events v JOIN articles a ON a.id = v.article_id) AS views,
    (SELECT COUNT(DISTINCT v.visitor_key) FROM article_view_events v JOIN articles a ON a.id = v.article_id) AS visitors
    FROM articles`).get() as ArticleListResult["stats"];
  return { articles: articles.map(({ unidentified, uvLimit, pvLimit, revision, ...article }) => ({
    ...article, access: accessFromUsage({ uvLimit, pvLimit, revision }, {
      views: article.viewCount, visitors: article.visitorCount, unidentified,
    }),
  })), total, page, pageSize, stats };
}

export type ArticleVisitorList = {
  article: { id: string; title: string };
  visitors: { visitorKey: string; viewCount: number; firstViewedAt: number; lastViewedAt: number; ipRegion: ArticleVisitorRegion | null }[];
  total: number; page: number; pageSize: number; viewCount: number; unidentifiedViews: number;
};

export function listArticleVisitors(articleId: string, requestedPage: string | null): ArticleVisitorList | null {
  const db = getDb();
  const article = db.prepare("SELECT id, title FROM articles WHERE id = ?").get(articleId) as ArticleVisitorList["article"] | undefined;
  if (!article) return null;
  const stats = db.prepare(`SELECT COUNT(*) AS viewCount, COUNT(DISTINCT visitor_key) AS total,
    COUNT(*) - COUNT(visitor_key) AS unidentifiedViews FROM article_view_events WHERE article_id = ?`).get(articleId) as Pick<ArticleVisitorList, "viewCount" | "total" | "unidentifiedViews">;
  const requested = Number(requestedPage || 1), pageSize = 20;
  const page = Math.min(Math.max(1, Number.isSafeInteger(requested) ? requested : 1), Math.max(1, Math.ceil(stats.total / pageSize)));
  const rows = db.prepare(`WITH visitors AS (SELECT visitor_key AS visitorKey, COUNT(*) AS viewCount,
    MIN(visited_at) AS firstViewedAt, MAX(visited_at) AS lastViewedAt
    FROM article_view_events WHERE article_id = ? AND visitor_key IS NOT NULL GROUP BY visitor_key
    ORDER BY lastViewedAt DESC, visitor_key ASC LIMIT ? OFFSET ?)
    SELECT v.*, r.province, r.city, r.source, r.resolved_at AS resolvedAt FROM visitors v
    LEFT JOIN article_view_regions r ON r.event_id = (
      SELECT e.id FROM article_view_events e WHERE e.article_id = ? AND e.visitor_key = v.visitorKey
      ORDER BY e.visited_at DESC, e.rowid DESC LIMIT 1
    ) ORDER BY v.lastViewedAt DESC, v.visitorKey ASC`).all(articleId, pageSize, (page - 1) * pageSize, articleId) as (
      Omit<ArticleVisitorList["visitors"][number], "ipRegion"> & { province: string | null; city: string | null; source: string | null; resolvedAt: number | null }
    )[];
  const visitors = rows.map(({ province, city, source, resolvedAt, ...visitor }) => ({ ...visitor,
    ipRegion: province && source === "amap-ip" && resolvedAt !== null ? { province, city: city || "", source: "amap-ip" as const, resolvedAt } : null,
  }));
  return { article, visitors, ...stats, page, pageSize };
}
