CREATE TABLE `image_import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`source_url` text NOT NULL,
	`local_url` text DEFAULT '' NOT NULL,
	`image_order` integer DEFAULT 0 NOT NULL,
	`alt_text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_import_items_task_idx` ON `image_import_items` (`task_id`,`image_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `image_import_items_task_source_idx` ON `image_import_items` (`task_id`,`source_url`);--> statement-breakpoint
CREATE TABLE `image_import_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`total_images` integer DEFAULT 0 NOT NULL,
	`completed_images` integer DEFAULT 0 NOT NULL,
	`failed_images` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_import_tasks_article_idx` ON `image_import_tasks` (`article_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `image_import_tasks_expires_idx` ON `image_import_tasks` (`expires_at`);