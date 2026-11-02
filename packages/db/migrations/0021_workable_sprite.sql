ALTER TABLE `lessons` ADD `project_key` text;--> statement-breakpoint
CREATE INDEX `lessons_project_key_idx` ON `lessons` (`project_key`,`promoted_at`,`id`);
--> statement-breakpoint
UPDATE lessons
SET project_key = json_extract(body, '$.evidence.project_key')
WHERE json_valid(body);