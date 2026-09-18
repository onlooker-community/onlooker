CREATE TABLE `session_summaries` (
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`session_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`event_count` integer NOT NULL,
	`counts_by_prefix` text NOT NULL,
	`plugins` text NOT NULL,
	`prompts` integer DEFAULT 0 NOT NULL,
	`compactions` integer DEFAULT 0 NOT NULL,
	`reported_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`machine_id`, `session_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machine_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_summaries_user_started_idx` ON `session_summaries` (`user_id`,`started_at`);