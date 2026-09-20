import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const articleViewEvents = sqliteTable("article_view_events", {
  id: text("id").primaryKey(),
  articleId: text("article_id").notNull(),
  visitedAt: integer("visited_at").notNull(),
  visitorKey: text("visitor_key"),
  accessRevision: integer("access_revision").notNull().default(-1),
}, (table) => [
  index("article_view_events_article_idx").on(table.articleId, table.visitedAt),
  index("article_view_events_visitor_idx").on(table.articleId, table.visitorKey, table.visitedAt),
  index("article_view_events_unique_visitor_idx").on(table.visitorKey),
]);

export const articleAccessPolicies = sqliteTable("article_access_policies", {
  articleId: text("article_id").primaryKey(),
  uvLimit: integer("uv_limit").default(10),
  pvLimit: integer("pv_limit"),
  revision: integer("revision").notNull().default(0),
});

export const articleViewRegions = sqliteTable("article_view_regions", {
  eventId: text("event_id").primaryKey(),
  province: text("province").notNull(),
  city: text("city").notNull(),
  source: text("source").notNull(),
  resolvedAt: integer("resolved_at").notNull(),
});

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

export const privateVideoAssets = sqliteTable("private_video_assets", {
  id: text("id").primaryKey(),
  objectPrefix: text("object_prefix").notNull(),
  bucket: text("bucket").notNull(),
  region: text("region").notNull(),
  manifest: text("manifest").notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const privateVideoAccessCodes = sqliteTable("private_video_access_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  label: text("label").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const privateVideoSessions = sqliteTable("private_video_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  codeId: text("code_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  index("private_video_sessions_code_idx").on(table.codeId),
  index("private_video_sessions_expiry_idx").on(table.expiresAt),
]);

export const privateVideoRateLimits = sqliteTable("private_video_rate_limits", {
  bucket: text("bucket").primaryKey(),
  attempts: integer("attempts").notNull(),
  resetsAt: integer("resets_at").notNull(),
}, table => [index("private_video_rate_limits_expiry_idx").on(table.resetsAt)]);

export const articleVideoShares = sqliteTable("article_video_shares", {
  articleId: text("article_id").primaryKey(),
  generation: text("generation").notNull(),
  codeHash: text("code_hash").notNull().unique(),
  wrappedCode: text("wrapped_code").notNull(),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const articleVideoViewerSessions = sqliteTable("article_video_viewer_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [index("article_video_viewer_sessions_expiry_idx").on(table.expiresAt)]);

export const articleVideoViewerGrants = sqliteTable("article_video_viewer_grants", {
  sessionHash: text("session_hash").notNull(),
  articleId: text("article_id").notNull(),
  generation: text("generation").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  primaryKey({ columns: [table.sessionHash, table.articleId] }),
  index("article_video_viewer_grants_article_idx").on(table.articleId),
  index("article_video_viewer_grants_expiry_idx").on(table.expiresAt),
]);
