import { getDb } from "../db";

export type ArticleAccess = {
  uvLimit: number | null; pvLimit: number | null; revision: number;
  usedUv: number; usedPv: number; unidentifiedViews: number;
  remainingUv: number | null; remainingPv: number | null; restricted: boolean;
};
type Policy = Pick<ArticleAccess, "uvLimit" | "pvLimit" | "revision">;
type Usage = { views: number; visitors: number; unidentified: number };
export type ArticleAccessDetails = { article: { id: string; title: string }; access: ArticleAccess };
export type ArticleAccessInput = { remainingUv: number | null; remainingPv: number | null; revision: number };

function policy(articleId: string): Policy {
  return getDb().prepare(`SELECT uv_limit AS uvLimit, pv_limit AS pvLimit, revision
    FROM article_access_policies WHERE article_id = ?`).get(articleId) as Policy | undefined
    ?? { uvLimit: 10, pvLimit: null, revision: 0 };
}

export function accessFromUsage(policy: Policy, usage: Usage): ArticleAccess {
  // Privacy-only visits remain unlinked. Each consumes one quota unit so that
  // disabling identity cannot bypass a UV cap; analytics UV still excludes NULL.
  const usedUv = usage.visitors + usage.unidentified;
  const remainingUv = policy.uvLimit === null ? null : Math.max(0, policy.uvLimit - usedUv);
  const remainingPv = policy.pvLimit === null ? null : Math.max(0, policy.pvLimit - usage.views);
  return { ...policy, usedUv, usedPv: usage.views, unidentifiedViews: usage.unidentified,
    remainingUv, remainingPv, restricted: remainingUv === 0 || remainingPv === 0 };
}

function usage(articleId: string): Usage {
  return getDb().prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_key) AS visitors,
    COUNT(*) - COUNT(visitor_key) AS unidentified FROM article_view_events WHERE article_id = ?`).get(articleId) as Usage;
}

export function getArticleAccess(articleId: string): ArticleAccessDetails | null {
  const article = getDb().prepare("SELECT id, title FROM articles WHERE id = ?").get(articleId) as ArticleAccessDetails["article"] | undefined;
  return article ? { article, access: accessFromUsage(policy(articleId), usage(articleId)) } : null;
}

export function parseArticleAccessInput(value: unknown): ArticleAccessInput | null {
  if (!value || typeof value !== "object") return null;
  const { remainingUv, remainingPv, revision } = value as Record<string, unknown>;
  const valid = (n: unknown) => n === null || (Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000_000);
  if (!valid(remainingUv) || !valid(remainingPv) || !Number.isSafeInteger(revision) || (revision as number) < 0) return null;
  return { remainingUv, remainingPv, revision } as ArticleAccessInput;
}

// Remaining allowances are applied to the counts at save time. Revision checks
// stop stale forms or a retried save from accidentally granting another batch.
export function setArticleAccess(articleId: string, input: ArticleAccessInput) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const current = getArticleAccess(articleId);
    if (!current) return { status: 404 as const };
    if (current.access.revision !== input.revision) return { status: 409 as const };
    const uvLimit = input.remainingUv === null ? null : current.access.usedUv + input.remainingUv;
    const pvLimit = input.remainingPv === null ? null : current.access.usedPv + input.remainingPv;
    db.prepare(`INSERT INTO article_access_policies (article_id, uv_limit, pv_limit, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(article_id) DO UPDATE SET uv_limit = excluded.uv_limit, pv_limit = excluded.pv_limit, revision = excluded.revision`)
      .run(articleId, uvLimit, pvLimit, input.revision + 1);
    const result = getArticleAccess(articleId)!;
    db.exec("COMMIT");
    committed = true;
    return { status: 200 as const, result };
  } finally {
    if (!committed) db.exec("ROLLBACK");
  }
}

export function admitArticleView(articleId: string, eventId: string, visitorKey: string | null) {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const article = db.prepare("SELECT content FROM articles WHERE id = ? AND status = 'published'").get(articleId) as { content: string } | undefined;
    if (!article) return { status: 404 as const };
    const current = policy(articleId);
    const previous = db.prepare(`SELECT article_id AS articleId, visitor_key AS visitorKey,
      visited_at AS visitedAt, access_revision AS revision FROM article_view_events WHERE id = ?`).get(eventId) as {
        articleId: string; visitorKey: string | null; visitedAt: number; revision: number;
      } | undefined;
    if (previous) {
      if (previous.articleId !== articleId || previous.visitorKey !== visitorKey) return { status: 409 as const };
      // A short retry window permits recovery when the response for the final
      // slot is lost. A new admin policy immediately invalidates previous grants.
      if (previous.revision !== current.revision || Date.now() - previous.visitedAt > 60_000) return { status: 403 as const };
      return { status: 200 as const, content: article.content };
    }
    if (accessFromUsage(current, usage(articleId)).restricted) return { status: 403 as const };
    db.prepare(`INSERT INTO article_view_events (id, article_id, visited_at, visitor_key, access_revision)
      VALUES (?, ?, ?, ?, ?)`).run(eventId, articleId, Date.now(), visitorKey, current.revision);
    db.exec("COMMIT");
    committed = true;
    return { status: 200 as const, content: article.content };
  } finally {
    if (!committed) db.exec("ROLLBACK");
  }
}
