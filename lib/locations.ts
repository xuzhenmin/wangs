import { env } from "cloudflare:workers";

export type ConsentedLocation = {
  id: string;
  deviceId: string;
  city: string;
  address: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  consentedAt: number;
  updatedAt: number;
  expiresAt: number;
};

function getDatabase() {
  const database = (env as unknown as { DB?: D1Database }).DB;
  if (!database) throw new Error("D1 binding DB is unavailable");
  return database;
}

async function ensureLocationSchema(database: D1Database) {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS consented_locations (
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
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS consented_locations_expires_idx ON consented_locations (expires_at)"),
  ]);
}

export async function saveConsentedLocation(location: ConsentedLocation) {
  const database = getDatabase();
  await ensureLocationSchema(database);
  await database.prepare(`INSERT INTO consented_locations (
    id, device_id, city, address, latitude, longitude, accuracy, consented_at, updated_at, expires_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    city = excluded.city,
    address = excluded.address,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    accuracy = excluded.accuracy,
    consented_at = excluded.consented_at,
    updated_at = excluded.updated_at,
    expires_at = excluded.expires_at`).bind(
      location.id,
      location.deviceId,
      location.city,
      location.address,
      location.latitude,
      location.longitude,
      location.accuracy,
      location.consentedAt,
      location.updatedAt,
      location.expiresAt
    ).run();
}

export async function listActiveLocations() {
  const database = getDatabase();
  await ensureLocationSchema(database);
  const result = await database.prepare(`SELECT
    id,
    device_id AS deviceId,
    city,
    address,
    latitude,
    longitude,
    accuracy,
    consented_at AS consentedAt,
    updated_at AS updatedAt,
    expires_at AS expiresAt
  FROM consented_locations
  WHERE expires_at > ?
  ORDER BY updated_at DESC
  LIMIT 500`).bind(Date.now()).all<ConsentedLocation>();
  return result.results;
}
