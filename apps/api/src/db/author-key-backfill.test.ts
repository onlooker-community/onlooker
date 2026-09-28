import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

// Sourced from the migration itself rather than hand-transcribed, so a change
// to the shipped UPDATE is what this test verifies - not a copy of it that
// could drift out of sync and still pass. The backfill is the last statement
// in 0008_stiff_swordsman.sql by construction, so `.at(-1)` is stable.
const BACKFILL =
	env.TEST_MIGRATIONS.find(
		(m) => m.name === "0008_stiff_swordsman.sql",
	)?.queries.at(-1) ?? "";

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

	// Guards the lookup above: if a future migration rename ever makes the
	// `find` miss, BACKFILL silently falls back to "" and every test below
	// would pass while asserting nothing. This is what makes that loud.
	it("resolves an UPDATE statement from the migration file", () => {
		expect(BACKFILL).not.toBe("");
		expect(BACKFILL).toContain("json_extract");
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
