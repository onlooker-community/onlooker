import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

const BACKFILL = `UPDATE lessons SET author_key = json_extract(body, '$.author_key')
	 WHERE author_key = ''`;

// The brief's literal fixture used a bare "u1" as user_id, but lessons.user_id
// is a foreign key onto users.id, and D1 enforces it - unlike bare sqlite,
// which does not by default. A real user is created below so the inserts
// below do not fail with SQLITE_CONSTRAINT_FOREIGNKEY.
let userId: string;

describe("author_key backfill", () => {
	beforeEach(async () => {
		await db().prepare("DELETE FROM lessons").run();
		await db().prepare("DELETE FROM users").run();
		const user = await createUser(
			db(),
			"author-key-backfill@example.com",
			"hash",
			"Ada",
		);
		userId = user.id;
	});

	it("reads author_key back out of the body for a pre-migration row", async () => {
		// Simulates a row written before 0008: the column takes its DEFAULT ''
		// and the real value exists only inside the JSON.
		const body = JSON.stringify({ author_key: "b".repeat(32) });
		await db()
			.prepare(
				`INSERT INTO lessons
				   (id, user_id, visibility, status, schema_version, body, author_key)
				 VALUES (?, ?, 'private', 'active', 2, ?, '')`,
			)
			.bind("01KZ45MKAM734ZS7JK24D2DK01", userId, body)
			.run();

		await db().prepare(BACKFILL).run();

		const row = await db()
			.prepare("SELECT author_key FROM lessons WHERE id = ?")
			.bind("01KZ45MKAM734ZS7JK24D2DK01")
			.first<{ author_key: string }>();

		expect(row?.author_key).toBe("b".repeat(32));
	});

	it("leaves a post-migration row alone", async () => {
		const body = JSON.stringify({ author_key: "b".repeat(32) });
		await db()
			.prepare(
				`INSERT INTO lessons
				   (id, user_id, visibility, status, schema_version, body, author_key)
				 VALUES (?, ?, 'private', 'active', 2, ?, ?)`,
			)
			.bind("01KZ45MKAM734ZS7JK24D2DK02", userId, body, "c".repeat(32))
			.run();

		await db().prepare(BACKFILL).run();

		const row = await db()
			.prepare("SELECT author_key FROM lessons WHERE id = ?")
			.bind("01KZ45MKAM734ZS7JK24D2DK02")
			.first<{ author_key: string }>();

		// The guard held: the column wins over the body.
		expect(row?.author_key).toBe("c".repeat(32));
	});
});
