import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
