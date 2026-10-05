-- Hand-completed: drizzle-kit v0.22.8's SQLiteAlterTableAddColumnConvertor
-- builds this ADD COLUMN's inline REFERENCES from only the target table and
-- column, never from onDelete/onUpdate, so it silently dropped the
-- ON DELETE SET NULL that schema.ts and meta/0011_snapshot.json both record.
-- Only this executed SQL disagreed with them; completing it by hand is what
-- the generator's own comment below asks for.
ALTER TABLE `lessons` ADD `org_id` text REFERENCES orgs(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `machine_tokens` ADD `org_id` text REFERENCES orgs(id) ON DELETE SET NULL;--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/