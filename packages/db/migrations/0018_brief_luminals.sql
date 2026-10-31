CREATE TABLE `mail_sends` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_sends_window_start_idx` ON `mail_sends` (`window_start`);