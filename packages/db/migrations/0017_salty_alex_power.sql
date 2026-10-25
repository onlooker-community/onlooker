CREATE TABLE `project_labels` (
	`user_id` text NOT NULL,
	`project_key` text NOT NULL,
	`machine_id` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`machine_id`, `project_key`, `source`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_labels_user_idx` ON `project_labels` (`user_id`);