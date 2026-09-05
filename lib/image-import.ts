import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "../db";
import { MAX_IMAGES_PER_ARTICLE } from "./article-images";

const TASK_LIFETIME_MS = 10 * 60 * 1000;

type ImportTaskRow = {
  id: string;
  articleId: string;
  tokenHash: string;
  status: "waiting" | "uploading" | "completed";
  totalImages: number;
  completedImages: number;
  failedImages: number;
  createdAt: number;
  expiresAt: number;
};

type ImportItemRow = {
  sourceUrl: string;
  localUrl: string;
  imageOrder: number;
  altText: string;
  status: "completed" | "failed";
  errorMessage: string;
};

export class ImageImportAuthorizationError extends Error {}
export class ImageImportValidationError extends Error {}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function validSourceUrl(sourceUrl: string) {
  return sourceUrl.length <= 2_048 && /^blob:https?:\/\//i.test(sourceUrl);
}

function cleanupExpiredTasks() {
  const database = getDb();
  const now = Date.now();
  database.prepare("DELETE FROM image_import_items WHERE task_id IN (SELECT id FROM image_import_tasks WHERE expires_at <= ?)").run(now);
  database.prepare("DELETE FROM image_import_tasks WHERE expires_at <= ?").run(now);
}

export function createImageImportTask(articleId: string) {
  cleanupExpiredTasks();
  const database = getDb();
  if (!database.prepare("SELECT id FROM articles WHERE id = ? LIMIT 1").get(articleId)) return null;
  const id = randomUUID();
  const uploadToken = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  const expiresAt = createdAt + TASK_LIFETIME_MS;
  database.prepare(`INSERT INTO image_import_tasks (
    id, article_id, token_hash, status, total_images, completed_images, failed_images, created_at, expires_at
  ) VALUES (?, ?, ?, 'waiting', 0, 0, 0, ?, ?)`).run(
    id,
    articleId,
    hashToken(uploadToken),
    createdAt,
    expiresAt,
  );
  return { id, uploadToken, expiresAt };
}

export function getImageImportTask(id: string) {
  const database = getDb();
  const task = database.prepare(`SELECT
    id,
    article_id AS articleId,
    token_hash AS tokenHash,
    status,
    total_images AS totalImages,
    completed_images AS completedImages,
    failed_images AS failedImages,
    created_at AS createdAt,
    expires_at AS expiresAt
  FROM image_import_tasks WHERE id = ? LIMIT 1`).get(id) as unknown as ImportTaskRow | undefined;
  if (!task) return null;
  const items = database.prepare(`SELECT
    source_url AS sourceUrl,
    local_url AS localUrl,
    image_order AS imageOrder,
    alt_text AS altText,
    status,
    error_message AS errorMessage
  FROM image_import_items
  WHERE task_id = ?
  ORDER BY image_order ASC`).all(id) as unknown as ImportItemRow[];
  return {
    id: task.id,
    articleId: task.articleId,
    status: task.expiresAt <= Date.now() && task.status !== "completed" ? "expired" : task.status,
    totalImages: task.totalImages,
    completedImages: task.completedImages,
    failedImages: task.failedImages,
    expiresAt: task.expiresAt,
    images: items,
  };
}

function authorizedTask(id: string, token: string) {
  const database = getDb();
  const task = database.prepare(`SELECT
    id,
    article_id AS articleId,
    token_hash AS tokenHash,
    status,
    total_images AS totalImages,
    completed_images AS completedImages,
    failed_images AS failedImages,
    created_at AS createdAt,
    expires_at AS expiresAt
  FROM image_import_tasks WHERE id = ? LIMIT 1`).get(id) as unknown as ImportTaskRow | undefined;
  if (!task || task.expiresAt <= Date.now()) throw new ImageImportAuthorizationError("导入任务不存在或已过期。");
  if (task.status === "completed") throw new ImageImportAuthorizationError("导入任务已经完成。");
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(task.tokenHash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ImageImportAuthorizationError("导入凭证无效。");
  }
  return task;
}

function refreshTaskProgress(taskId: string, totalImages: number) {
  const database = getDb();
  const counts = database.prepare(`SELECT
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedImages,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedImages
  FROM image_import_items WHERE task_id = ?`).get(taskId) as { completedImages: number | null; failedImages: number | null };
  const completedImages = counts.completedImages || 0;
  const failedImages = counts.failedImages || 0;
  const processedImages = completedImages + failedImages;
  const status = totalImages > 0 && processedImages >= totalImages ? "completed" : "uploading";
  database.prepare(`UPDATE image_import_tasks SET
    status = ?, total_images = ?, completed_images = ?, failed_images = ?
  WHERE id = ?`).run(status, totalImages, completedImages, failedImages, taskId);
}

function validateItemInput(sourceUrl: string, totalImages: number, imageOrder: number) {
  if (!validSourceUrl(sourceUrl)) throw new ImageImportValidationError("Blob 图片地址无效。");
  if (!Number.isInteger(totalImages) || totalImages < 1 || totalImages > MAX_IMAGES_PER_ARTICLE) {
    throw new ImageImportValidationError(`每次最多导入 ${MAX_IMAGES_PER_ARTICLE} 张图片。`);
  }
  if (!Number.isInteger(imageOrder) || imageOrder < 0 || imageOrder >= totalImages) {
    throw new ImageImportValidationError("图片顺序无效。");
  }
}

export function recordImportedImage(input: {
  taskId: string;
  token: string;
  sourceUrl: string;
  localUrl: string;
  totalImages: number;
  imageOrder: number;
  altText: string;
}) {
  const task = authorizedTask(input.taskId, input.token);
  validateItemInput(input.sourceUrl, input.totalImages, input.imageOrder);
  if (task.totalImages && task.totalImages !== input.totalImages) {
    throw new ImageImportValidationError("本次导入的图片总数不一致。");
  }
  const database = getDb();
  database.prepare(`INSERT INTO image_import_items (
    id, task_id, source_url, local_url, image_order, alt_text, status, error_message, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'completed', '', ?)
  ON CONFLICT(task_id, source_url) DO UPDATE SET
    local_url = excluded.local_url,
    image_order = excluded.image_order,
    alt_text = excluded.alt_text,
    status = 'completed',
    error_message = ''`).run(
    randomUUID(),
    task.id,
    input.sourceUrl,
    input.localUrl,
    input.imageOrder,
    input.altText.slice(0, 500),
    Date.now(),
  );
  refreshTaskProgress(task.id, input.totalImages);
  return task.articleId;
}

export function recordImageImportFailure(input: {
  taskId: string;
  token: string;
  sourceUrl: string;
  totalImages: number;
  imageOrder: number;
  altText: string;
  errorMessage: string;
}) {
  const task = authorizedTask(input.taskId, input.token);
  validateItemInput(input.sourceUrl, input.totalImages, input.imageOrder);
  if (task.totalImages && task.totalImages !== input.totalImages) {
    throw new ImageImportValidationError("本次导入的图片总数不一致。");
  }
  const database = getDb();
  database.prepare(`INSERT INTO image_import_items (
    id, task_id, source_url, local_url, image_order, alt_text, status, error_message, created_at
  ) VALUES (?, ?, ?, '', ?, ?, 'failed', ?, ?)
  ON CONFLICT(task_id, source_url) DO UPDATE SET
    local_url = '',
    image_order = excluded.image_order,
    alt_text = excluded.alt_text,
    status = 'failed',
    error_message = excluded.error_message`).run(
    randomUUID(),
    task.id,
    input.sourceUrl,
    input.imageOrder,
    input.altText.slice(0, 500),
    input.errorMessage.slice(0, 500),
    Date.now(),
  );
  refreshTaskProgress(task.id, input.totalImages);
}

export function authorizeImageImportTask(taskId: string, token: string) {
  return authorizedTask(taskId, token);
}
