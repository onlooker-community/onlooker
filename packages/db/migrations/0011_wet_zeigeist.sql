ALTER TABLE `lessons` ADD `org_id` text REFERENCES orgs(id);--> statement-breakpoint
ALTER TABLE `machine_tokens` ADD `org_id` text REFERENCES orgs(id);--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/