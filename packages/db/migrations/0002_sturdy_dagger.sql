CREATE TABLE `machine_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_tokens_token_hash_idx` ON `machine_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `machine_tokens_user_id_idx` ON `machine_tokens` (`user_id`);