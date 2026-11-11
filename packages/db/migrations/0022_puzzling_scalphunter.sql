CREATE TABLE `lesson_stacks` (
	`lesson_id` text NOT NULL,
	`stack` text NOT NULL,
	PRIMARY KEY(`lesson_id`, `stack`),
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO lesson_stacks (lesson_id, stack)
SELECT l.id, s.value
FROM lessons l, json_each(l.body, '$.applies_to.stack') s
WHERE json_valid(l.body) AND s.type = 'text';