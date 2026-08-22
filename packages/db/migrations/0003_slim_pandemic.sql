CREATE TABLE `lesson_feed` (
	`seq` integer NOT NULL,
	`user_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`status` text NOT NULL,
	`schema_version` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_feed_user_seq_idx` ON `lesson_feed` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `lesson_feed_lesson_id_idx` ON `lesson_feed` (`lesson_id`);--> statement-breakpoint
CREATE INDEX `lessons_user_id_idx` ON `lessons` (`user_id`);