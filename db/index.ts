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
  `);
  return database;
}
