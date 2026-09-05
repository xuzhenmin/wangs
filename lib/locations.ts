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
  renewConsent?: boolean;
};

export class LocationConsentRevokedError extends Error {
  constructor() {
    super("位置授权已被管理员撤销，需要用户重新确认授权。");
    this.name = "LocationConsentRevokedError";
  }
}

function transaction<T>(callback: () => T) {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function saveConsentedLocation(location: ConsentedLocation) {
  const database = getDb();
  transaction(() => {
    if (location.renewConsent === false) {
      const revoked = database.prepare("SELECT 1 FROM revoked_location_consents WHERE device_id = ? LIMIT 1").get(location.deviceId);
      if (revoked) throw new LocationConsentRevokedError();
    } else {
      database.prepare("DELETE FROM revoked_location_consents WHERE device_id = ?").run(location.deviceId);
    }
    database.prepare(`INSERT INTO consented_locations (
      id, device_id, city, address, latitude, longitude, accuracy, consented_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      city = excluded.city,
      address = excluded.address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      accuracy = excluded.accuracy,
      consented_at = CASE WHEN ? = 1 THEN excluded.consented_at ELSE consented_locations.consented_at END,
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
        location.expiresAt,
        location.renewConsent === false ? 0 : 1,
      );
  });
}

export function isLocationConsentRevoked(deviceId: string) {
  return Boolean(getDb().prepare("SELECT 1 FROM revoked_location_consents WHERE device_id = ? LIMIT 1").get(deviceId));
}

export function revokeLocationConsent(id: string) {
  const database = getDb();
  return transaction(() => {
    const location = database.prepare(`SELECT
      id,
      device_id AS deviceId
    FROM consented_locations
    WHERE id = ?
    LIMIT 1`).get(id) as { id: string; deviceId: string } | undefined;
    if (!location) return null;
    const revokedAt = Date.now();
    database.prepare(`INSERT INTO revoked_location_consents (device_id, revoked_at)
      VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET revoked_at = excluded.revoked_at`).run(location.deviceId, revokedAt);
    database.prepare("DELETE FROM consented_locations WHERE id = ?").run(location.id);
    return { id: location.id, deviceId: location.deviceId, revokedAt };
  });
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
