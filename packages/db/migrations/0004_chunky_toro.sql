ALTER TABLE `lessons` ADD `promoted_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `lessons_user_promoted_at_idx` ON `lessons` (`user_id`,`promoted_at`);--> statement-breakpoint
-- Existing rows took the DEFAULT '' above. Their real value is already in
-- the JSON body, which is where this column was lifted from, so the backfill
-- reads it back out rather than inventing a timestamp.
--
-- Guarded on promoted_at = '' so re-running is a no-op: a lesson ingested
-- after this migration already has the correct value and must not be
-- overwritten by whatever its body says.
UPDATE `lessons` SET `promoted_at` = json_extract(`body`, '$.promoted_at') WHERE `promoted_at` = '';
