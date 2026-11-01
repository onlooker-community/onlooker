CREATE TABLE `session_projects` (
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_key` text NOT NULL,
	`basis` text NOT NULL,
	`event_count` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `project_key`, `session_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`,`session_id`) REFERENCES `session_summaries`(`machine_id`,`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_projects_user_key_idx` ON `session_projects` (`user_id`,`project_key`);
--> statement-breakpoint
INSERT INTO `session_projects` (`user_id`, `machine_id`, `session_id`, `project_key`, `basis`, `event_count`)
SELECT s.`user_id`, s.`machine_id`, s.`session_id`, j.key,
       json_extract(j.value, '$.basis'), json_extract(j.value, '$.event_count')
  FROM `session_summaries` s, json_each(s.`counts_by_project`) j
 WHERE json_valid(s.`counts_by_project`);