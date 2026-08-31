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
  `);
  return database;
}
