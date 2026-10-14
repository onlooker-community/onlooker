CREATE TABLE `login_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`fails` integer NOT NULL,
	`last_fail_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_last_fail_at_idx` ON `login_attempts` (`last_fail_at`);