import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

// Sourced from the migration itself rather than hand-transcribed, so a change
// to the shipped UPDATE is what this test verifies - not a copy of it that
// could drift out of sync and still pass. The backfill is the last statement
// in 0004 by construction, so `.at(-1)` is stable.
const BACKFILL =
	env.TEST_MIGRATIONS.find(
		(m) => m.name === "0004_chunky_toro.sql",
	)?.queries.at(-1) ?? "";

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "backfill@example.com", "hash", "Ada");
	userId = user.id;
});

/** A row shaped the way migration 0004 leaves a pre-existing lesson. */
async function seedUnbackfilled(id: string, promotedAt: string) {
	await db()
		.prepare(
			`INSERT INTO lessons
				(id, user_id, visibility, status, schema_version, body, promoted_at)
			 VALUES (?, ?, 'private', 'active', 2, ?, '')`,
		)
		.bind(id, userId, JSON.stringify({ id, promoted_at: promotedAt }))
		.run();
}

const promotedAtOf = async (id: string) =>
	(
		await db()
			.prepare("SELECT promoted_at FROM lessons WHERE id = ?")
			.bind(id)
			.first<{ promoted_at: string }>()
	)?.promoted_at;

describe("the 0004 backfill", () => {
	// Guards the lookup above: if a future migration rename ever makes the
	// `find` miss, BACKFILL silently falls back to "" and every test below
	// would pass while asserting nothing. This is what makes that loud.
	it("resolves an UPDATE statement from the migration file", () => {
		expect(BACKFILL).not.toBe("");
		expect(BACKFILL).toContain("json_extract");
	});

	it("copies promoted_at out of the body", async () => {
		await seedUnbackfilled(
			"01BACKFILL0000000000000001",
			"2026-08-20T00:00:00.000Z",
		);

		await db().prepare(BACKFILL).run();

		expect(await promotedAtOf("01BACKFILL0000000000000001")).toBe(
			"2026-08-20T00:00:00.000Z",
		);
	});

	// The guard that makes re-running safe. Without WHERE promoted_at = '',
	// a second run would overwrite a correct column value with whatever the
	// body happened to say.
	it("leaves an already-populated row alone", async () => {
		await seedUnbackfilled(
			"01BACKFILL0000000000000002",
			"2026-08-20T00:00:00.000Z",
		);
		await db()
			.prepare("UPDATE lessons SET promoted_at = ? WHERE id = ?")
			.bind("2026-08-21T00:00:00.000Z", "01BACKFILL0000000000000002")
			.run();

		await db().prepare(BACKFILL).run();

		expect(await promotedAtOf("01BACKFILL0000000000000002")).toBe(
			"2026-08-21T00:00:00.000Z",
		);
	});
});
