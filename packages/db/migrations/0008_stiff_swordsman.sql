CREATE TABLE `lesson_author_blocks` (
	`author_key` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `lessons` ADD `author_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `lessons_author_key_idx` ON `lessons` (`author_key`);--> statement-breakpoint
-- Existing rows took the DEFAULT '' above. Their real value is already in the
-- JSON body, which is where this column was lifted from, so the backfill reads
-- it back out rather than inventing one.
--
-- Guarded on author_key = '' so re-running is a no-op: a lesson ingested after
-- this migration already has the correct value and must not be overwritten by
-- whatever its body says.
UPDATE `lessons` SET `author_key` = COALESCE(json_extract(`body`, '$.author_key'), '') WHERE `author_key` = '';
