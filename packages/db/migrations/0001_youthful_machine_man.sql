ALTER TABLE `verification_tokens` RENAME COLUMN `token` TO `token_hash`;--> statement-breakpoint
DROP INDEX IF EXISTS `verification_tokens_token_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_token_idx` ON `verification_tokens` (`token_hash`);