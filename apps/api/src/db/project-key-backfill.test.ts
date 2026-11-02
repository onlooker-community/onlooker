import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

// Sourced from the migration itself, as author-key-backfill.test.ts does, so a
// change to the shipped UPDATE is what this verifies. The backfill is the last
// statement of the migration that added lessons.project_key by construction.
const MIGRATION = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0021_"));
const BACKFILL = MIGRATION?.queries.at(-1) ?? "";

let userId: string;

async function insert(id: string, body: string): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO lessons
			   (id, user_id, visibility, status, schema_version, body, author_key)
			 VALUES (?, ?, 'private', 'active', 2, ?, '')`,
		)
		.bind(id, userId, body)
		.run();
}

async function keyOf(id: string): Promise<string | null | undefined> {
	const row = await db()
		.prepare("SELECT project_key FROM lessons WHERE id = ?")
		.bind(id)
		.first<{ project_key: string | null }>();
	return row?.project_key;
}

describe("project_key backfill", () => {
	beforeEach(async () => {
		await db().prepare("DELETE FROM lessons").run();
		await db().prepare("DELETE FROM users").run();
		const user = await createUser(
			db(),
			"project-key-backfill@example.com",
			"hash",
			"Ada",
		);
		userId = user.id;
	});

	// If a future migration rename makes the lookup miss, BACKFILL falls back
	// to "" and every test below would pass while asserting nothing.
	it("resolves an UPDATE statement from the migration file", () => {
		expect(BACKFILL).toContain("json_extract");
	});

	it("reads the key back out of the body for a pre-migration row", async () => {
		const body = JSON.stringify({ evidence: { project_key: "6a7678979e31" } });
		await insert("01KZ45MKAM734ZS7JK24D2DK01", body);

		await db().prepare(BACKFILL).run();

		expect(await keyOf("01KZ45MKAM734ZS7JK24D2DK01")).toBe("6a7678979e31");
	});

	it("leaves a row with an unparsable body NULL instead of failing", async () => {
		await insert("01KZ45MKAM734ZS7JK24D2DK02", "not json {");

		await db().prepare(BACKFILL).run();

		expect(await keyOf("01KZ45MKAM734ZS7JK24D2DK02")).toBeNull();
	});
});
