DROP INDEX IF EXISTS `lessons_user_promoted_at_idx`;--> statement-breakpoint
CREATE INDEX `lessons_user_promoted_at_idx` ON `lessons` (`user_id`,`promoted_at`,`id`);