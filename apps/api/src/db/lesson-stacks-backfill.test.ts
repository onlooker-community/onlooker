import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "./queries.js";

const db = () => env.DB;

// Sourced from the migration itself, as project-key-backfill.test.ts does, so
// a change to the shipped INSERT is what this verifies. The backfill is the
// last statement of the migration that added lesson_stacks by construction.
const MIGRATION = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0022_"));
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

async function stacksOf(id: string): Promise<string[]> {
	const { results } = await db()
		.prepare(
			"SELECT stack FROM lesson_stacks WHERE lesson_id = ? ORDER BY stack",
		)
		.bind(id)
		.all<{ stack: string }>();
	return results.map((row) => row.stack);
}

const body = (stack: unknown) => JSON.stringify({ applies_to: { stack } });

describe("lesson_stacks backfill", () => {
	beforeEach(async () => {
		await db().prepare("DELETE FROM lessons").run();
		await db().prepare("DELETE FROM users").run();
		const user = await createUser(
			db(),
			"lesson-stacks-backfill@example.com",
			"hash",
			"Ada",
		);
		userId = user.id;
	});

	// If a future migration rename makes the lookup miss, BACKFILL falls back
	// to "" and every test below would pass while asserting nothing.
	it("resolves an INSERT into lesson_stacks from the migration file", () => {
		expect(BACKFILL).toContain("INSERT OR IGNORE INTO lesson_stacks");
	});

	it("reads the stacks back out of the body for a pre-migration row", async () => {
		await insert("01KZ45MKAM734ZS7JK24D2DS01", body(["vite", "react"]));

		await db().prepare(BACKFILL).run();

		expect(await stacksOf("01KZ45MKAM734ZS7JK24D2DS01")).toEqual([
			"react",
			"vite",
		]);
	});

	it("writes a repeated entry once", async () => {
		await insert("01KZ45MKAM734ZS7JK24D2DS02", body(["vite", "vite"]));

		await db().prepare(BACKFILL).run();

		expect(await stacksOf("01KZ45MKAM734ZS7JK24D2DS02")).toEqual(["vite"]);
	});

	it("writes nothing for an unparsable body instead of failing", async () => {
		await insert("01KZ45MKAM734ZS7JK24D2DS03", "not json {");

		await db().prepare(BACKFILL).run();

		expect(await stacksOf("01KZ45MKAM734ZS7JK24D2DS03")).toEqual([]);
	});

	it("changes nothing when run a second time", async () => {
		await insert("01KZ45MKAM734ZS7JK24D2DS04", body(["vite"]));

		await db().prepare(BACKFILL).run();
		await db().prepare(BACKFILL).run();

		expect(await stacksOf("01KZ45MKAM734ZS7JK24D2DS04")).toEqual(["vite"]);
	});
});
