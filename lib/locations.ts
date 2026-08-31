import { getDb } from "../db";

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

export async function saveConsentedLocation(location: ConsentedLocation) {
  const database = getDb();
  database.prepare(`INSERT INTO consented_locations (
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
    expires_at = excluded.expires_at`).run(
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
    );
}

export async function listActiveLocations() {
  const database = getDb();
  return database.prepare(`SELECT
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
  LIMIT 500`).all(Date.now()) as unknown as ConsentedLocation[];
}
