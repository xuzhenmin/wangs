import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const consentedLocations = sqliteTable("consented_locations", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().unique(),
  city: text("city").notNull(),
  address: text("address").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  accuracy: real("accuracy").notNull(),
  consentedAt: integer("consented_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("consented_locations_expires_idx").on(table.expiresAt)]);

export const revokedLocationConsents = sqliteTable("revoked_location_consents", {
  deviceId: text("device_id").primaryKey(),
  revokedAt: integer("revoked_at").notNull(),
});

export const articles = sqliteTable("articles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  content: text("content").notNull().default(""),
  status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("articles_updated_idx").on(table.updatedAt)]);

export const imageImportTasks = sqliteTable("image_import_tasks", {
  id: text("id").primaryKey(),
  articleId: text("article_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: ["waiting", "uploading", "completed"] }).notNull().default("waiting"),
  totalImages: integer("total_images").notNull().default(0),
  completedImages: integer("completed_images").notNull().default(0),
  failedImages: integer("failed_images").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("image_import_tasks_article_idx").on(table.articleId, table.createdAt),
  index("image_import_tasks_expires_idx").on(table.expiresAt),
]);

export const imageImportItems = sqliteTable("image_import_items", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  sourceUrl: text("source_url").notNull(),
  localUrl: text("local_url").notNull().default(""),
  imageOrder: integer("image_order").notNull().default(0),
  altText: text("alt_text").notNull().default(""),
  status: text("status", { enum: ["completed", "failed"] }).notNull(),
  errorMessage: text("error_message").notNull().default(""),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("image_import_items_task_idx").on(table.taskId, table.imageOrder),
  uniqueIndex("image_import_items_task_source_idx").on(table.taskId, table.sourceUrl),
]);
