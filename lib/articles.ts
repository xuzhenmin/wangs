import { getDb } from "../db";
import { hasPendingArticleImages } from "./article-images";

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

export class ExternalImagesPendingError extends Error {
  constructor() {
    super("正文仍有未本地化图片，请先点击“处理待处理图片”并按提示完成处理后再发布。");
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
  if (input.status === "published" && hasPendingArticleImages(input.content)) {
    throw new ExternalImagesPendingError();
  }
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
  return { article };
}

export async function updateArticle(id: string, input: ArticleInput) {
  const exists = getDb().prepare("SELECT id FROM articles WHERE id = ?").get(id);
  if (!exists) return null;
  if (input.status === "published" && hasPendingArticleImages(input.content)) {
    throw new ExternalImagesPendingError();
  }
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
  return { article };
}

export function upsertSyncedArticle(
  id: string,
  input: ArticleInput,
  timestamps: { createdAt: number; updatedAt: number },
) {
  if (input.status !== "published" || hasPendingArticleImages(input.content)) {
    throw new ExternalImagesPendingError();
  }
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
