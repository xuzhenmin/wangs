import { getDb } from "../db";
import { assertArticleUsesOssImages } from "./oss-article-images";

export type ArticleStatus = "draft" | "published";

export type Article = {
  id: string;
  title: string;
  summary: string;
  content: string;
  status: ArticleStatus;
  createdAt: number;
  updatedAt: number;
};

export type ArticleInput = Pick<Article, "title" | "summary" | "content" | "status">;

export function randomPublishedHeadlines() {
  return getDb().prepare(`SELECT id, title FROM articles
    WHERE status = 'published' ORDER BY RANDOM() LIMIT 3`).all() as { id: string; title: string }[];
}

export class ExternalImagesPendingError extends Error {
  constructor() {
    super("请先在本地发布文章，完成图片处理后再同步到远端。");
    this.name = "ExternalImagesPendingError";
  }
}

export function parseArticleInput(value: unknown): ArticleInput | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const status: ArticleStatus = body.status === "published" ? "published" : "draft";
  if (!title || title.length > 160 || summary.length > 500 || content.length > 200_000) return null;
  return { title, summary, content, status };
}

export async function listArticles() {
  return getDb().prepare(`SELECT
    id,
    title,
    summary,
    content,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM articles
  ORDER BY updated_at DESC`).all() as unknown as Article[];
}

export async function getPublishedArticle(id: string) {
  return getDb().prepare(`SELECT
    id,
    title,
    summary,
    content,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM articles
  WHERE id = ? AND status = 'published'
  LIMIT 1`).get(id) as unknown as Article | undefined;
}

export function getArticle(id: string) {
  return getDb().prepare(`SELECT
    id,
    title,
    summary,
    content,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM articles
  WHERE id = ?
  LIMIT 1`).get(id) as unknown as Article | undefined;
}

export function articleExists(id: string) {
  return Boolean(getDb().prepare("SELECT id FROM articles WHERE id = ? LIMIT 1").get(id));
}

export async function createArticle(input: ArticleInput) {
  const id = crypto.randomUUID();
  const article: Article = {
    id,
    ...input,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getDb().prepare(`INSERT INTO articles (
    id, title, summary, content, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    article.id,
    article.title,
    article.summary,
    article.content,
    article.status,
    article.createdAt,
    article.updatedAt,
  );
  return { article, uploadedImageCount: 0 };
}

export async function updateArticle(id: string, input: ArticleInput) {
  const exists = getDb().prepare("SELECT id FROM articles WHERE id = ?").get(id);
  if (!exists) return null;
  const updatedAt = Date.now();
  const result = getDb().prepare(`UPDATE articles SET
    title = ?,
    summary = ?,
    content = ?,
    status = ?,
    updated_at = ?
  WHERE id = ?`).run(
    input.title,
    input.summary,
    input.content,
    input.status,
    updatedAt,
    id,
  );
  if (!result.changes) return null;
  const article = getDb().prepare(`SELECT
    id,
    title,
    summary,
    content,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM articles WHERE id = ?`).get(id) as unknown as Article;
  return { article, uploadedImageCount: 0 };
}

// Uploading may take time. Only replace the snapshot that was checked, never
// overwrite edits or a change back to draft made while the upload was running.
export function saveOssContentForSync(snapshot: Article, content: string): Article | null {
  assertArticleUsesOssImages(snapshot.id, content);
  if (content === snapshot.content) {
    const current = getArticle(snapshot.id);
    return current?.status === "published"
      && current.updatedAt === snapshot.updatedAt
      && current.content === snapshot.content
      && current.title === snapshot.title
      && current.summary === snapshot.summary
      ? current : null;
  }
  const updatedAt = Math.max(Date.now(), snapshot.updatedAt + 1);
  const result = getDb().prepare(`UPDATE articles SET content = ?, updated_at = ?
    WHERE id = ? AND status = 'published' AND updated_at = ?
      AND content = ? AND title = ? AND summary = ?`).run(
    content, updatedAt, snapshot.id, snapshot.updatedAt,
    snapshot.content, snapshot.title, snapshot.summary,
  );
  return result.changes ? { ...snapshot, content, updatedAt } : null;
}

export function upsertSyncedArticle(
  id: string,
  input: ArticleInput,
  timestamps: { createdAt: number; updatedAt: number },
) {
  if (input.status !== "published") {
    throw new ExternalImagesPendingError();
  }
  assertArticleUsesOssImages(id, input.content);
  const database = getDb();
  database.prepare(`INSERT INTO articles (
    id, title, summary, content, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'published', ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    summary = excluded.summary,
    content = excluded.content,
    status = 'published',
    updated_at = excluded.updated_at`).run(
    id,
    input.title,
    input.summary,
    input.content,
    timestamps.createdAt,
    timestamps.updatedAt,
  );
  return database.prepare(`SELECT
    id,
    title,
    summary,
    content,
    status,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM articles WHERE id = ?`).get(id) as unknown as Article;
}
