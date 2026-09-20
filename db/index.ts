import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let database: DatabaseSync | undefined;

function databasePath() {
  const configuredPath = process.env.LOCATION_DB_PATH;
  return configuredPath || path.join(process.cwd(), "data", "wangs.sqlite");
}

export function getDb() {
  if (database) return database;

  const filename = databasePath();
  mkdirSync(path.dirname(filename), { recursive: true });
  database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS consented_locations (
      id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy REAL NOT NULL,
      consented_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS consented_locations_expires_idx
      ON consented_locations (expires_at);
    CREATE TABLE IF NOT EXISTS revoked_location_consents (
      device_id TEXT PRIMARY KEY NOT NULL,
      revoked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS articles_updated_idx
      ON articles (updated_at);
    CREATE TABLE IF NOT EXISTS article_view_events (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      visitor_key TEXT
    );
    CREATE INDEX IF NOT EXISTS article_view_events_article_idx
      ON article_view_events (article_id, visited_at);
    CREATE TABLE IF NOT EXISTS article_access_policies (
      article_id TEXT PRIMARY KEY NOT NULL,
      uv_limit INTEGER DEFAULT 10,
      pv_limit INTEGER,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS article_view_regions (
      event_id TEXT PRIMARY KEY NOT NULL,
      province TEXT NOT NULL,
      city TEXT NOT NULL,
      source TEXT NOT NULL,
      resolved_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_import_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      article_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      total_images INTEGER NOT NULL DEFAULT 0,
      completed_images INTEGER NOT NULL DEFAULT 0,
      failed_images INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_import_tasks_article_idx
      ON image_import_tasks (article_id, created_at);
    CREATE INDEX IF NOT EXISTS image_import_tasks_expires_idx
      ON image_import_tasks (expires_at);
    CREATE TABLE IF NOT EXISTS image_import_items (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      local_url TEXT NOT NULL DEFAULT '',
      image_order INTEGER NOT NULL DEFAULT 0,
      alt_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, source_url)
    );
    CREATE INDEX IF NOT EXISTS image_import_items_task_idx
      ON image_import_items (task_id, image_order);
    CREATE TABLE IF NOT EXISTS private_video_assets (
      id TEXT PRIMARY KEY NOT NULL,
      object_prefix TEXT NOT NULL,
      bucket TEXT NOT NULL,
      region TEXT NOT NULL,
      manifest TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_video_access_codes (
      id TEXT PRIMARY KEY NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS private_video_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      code_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS private_video_sessions_code_idx ON private_video_sessions (code_id);
    CREATE INDEX IF NOT EXISTS private_video_sessions_expiry_idx ON private_video_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS private_video_rate_limits (
      bucket TEXT PRIMARY KEY NOT NULL,
      attempts INTEGER NOT NULL,
      resets_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS private_video_rate_limits_expiry_idx ON private_video_rate_limits (resets_at);
    CREATE TABLE IF NOT EXISTS article_video_shares (
      article_id TEXT PRIMARY KEY NOT NULL,
      generation TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      wrapped_code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS article_video_viewer_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS article_video_viewer_sessions_expiry_idx ON article_video_viewer_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS article_video_viewer_grants (
      session_hash TEXT NOT NULL,
      article_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (session_hash, article_id)
    );
    CREATE INDEX IF NOT EXISTS article_video_viewer_grants_article_idx ON article_video_viewer_grants (article_id);
    CREATE INDEX IF NOT EXISTS article_video_viewer_grants_expiry_idx ON article_video_viewer_grants (expires_at);
  `);
  // Additive, idempotent upgrade: preserve historical PV with a NULL visitor.
  // The write lock also prevents two server workers racing the ALTER TABLE.
  database.exec("BEGIN IMMEDIATE");
  try {
    const columns = database.prepare("PRAGMA table_info(article_view_events)").all();
    if (!columns.some(column => column.name === "visitor_key")) database.exec("ALTER TABLE article_view_events ADD COLUMN visitor_key TEXT");
    if (!columns.some(column => column.name === "access_revision")) database.exec("ALTER TABLE article_view_events ADD COLUMN access_revision INTEGER NOT NULL DEFAULT -1");
    database.exec("CREATE INDEX IF NOT EXISTS article_view_events_visitor_idx ON article_view_events (article_id, visitor_key, visited_at)");
    database.exec("CREATE INDEX IF NOT EXISTS article_view_events_unique_visitor_idx ON article_view_events (visitor_key)");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK"); database.close(); database = undefined; throw error;
  }
  return database;
}
