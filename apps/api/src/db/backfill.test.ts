import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

/** The statement appended to migration 0004, verbatim. */
const BACKFILL =
	"UPDATE lessons SET promoted_at = json_extract(body, '$.promoted_at') WHERE promoted_at = ''";

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(
		db(),
		"backfill@example.com",
		"hash",
		"Ada",
	);
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
	it("copies promoted_at out of the body", async () => {
		await seedUnbackfilled("01BACKFILL0000000000000001", "2026-08-20T00:00:00.000Z");

		await db().prepare(BACKFILL).run();

		expect(await promotedAtOf("01BACKFILL0000000000000001")).toBe(
			"2026-08-20T00:00:00.000Z",
		);
	});

	// The guard that makes re-running safe. Without WHERE promoted_at = '',
	// a second run would overwrite a correct column value with whatever the
	// body happened to say.
	it("leaves an already-populated row alone", async () => {
		await seedUnbackfilled("01BACKFILL0000000000000002", "2026-08-20T00:00:00.000Z");
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
