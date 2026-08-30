CREATE TABLE `consented_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`city` text NOT NULL,
	`address` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`accuracy` real NOT NULL,
	`consented_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consented_locations_device_id_unique` ON `consented_locations` (`device_id`);--> statement-breakpoint
CREATE INDEX `consented_locations_expires_idx` ON `consented_locations` (`expires_at`);