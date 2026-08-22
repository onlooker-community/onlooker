import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonWithFeed, getLessonById } from "./lessons.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let userId: string;
let counter = 0;

function lesson(overrides: Partial<TLesson> = {}): TLesson {
	counter += 1;
	const id = `01KZ45MKAM734ZS7JK24D2DK${counter.toString().padStart(2, "0")}`;
	return {
		id,
		schema_version: 2,
		claim: "Pin rollup when vite is below 6",
		rationale: "The bundled rollup version drifts",
		evidence: { artifact_ids: [], resolution: "pinned rollup" },
		applies_to: {
			stack: ["vite"],
			scope: { kind: "versioned", versions: { vite: "<6" } },
			file_patterns: [],
			task_kinds: [],
		},
		visibility: "private",
		consensus: { judges: 3, agreed: 2, decided_at: "2026-08-22T00:00:00.000Z" },
		status: "active",
		superseded_by: null,
		source: "local",
		author_key: "a".repeat(32),
		promoted_at: "2026-08-22T00:00:00.000Z",
		...overrides,
	} as TLesson;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "l@example.com", "hash", "Ada");
	userId = user.id;
	counter = 0;
});

describe("createLessonWithFeed", () => {
	it("assigns the first lesson seq 1", async () => {
		expect(await createLessonWithFeed(db(), userId, lesson())).toBe(1);
	});

	// The property the whole delta protocol rests on. If seq has holes, the
	// client's contiguity check reports corruption on healthy data.
	it("assigns a dense sequence", async () => {
		const assigned = [
			await createLessonWithFeed(db(), userId, lesson()),
			await createLessonWithFeed(db(), userId, lesson()),
			await createLessonWithFeed(db(), userId, lesson()),
		];

		expect(assigned).toEqual([1, 2, 3]);
	});

	// seq is per user, not global. A global counter would leave each user's own
	// stream full of gaps wherever anyone else wrote.
	it("counts separately for each user", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");

		await createLessonWithFeed(db(), userId, lesson());
		await createLessonWithFeed(db(), userId, lesson());

		expect(await createLessonWithFeed(db(), other.id, lesson())).toBe(1);
	});

	it("writes the body and the feed row together", async () => {
		const written = lesson();
		await createLessonWithFeed(db(), userId, written);

		const stored = await getLessonById(db(), written.id);
		expect(stored?.user_id).toBe(userId);
		expect(JSON.parse(stored?.body ?? "{}").claim).toBe(written.claim);

		const feed = await db()
			.prepare("SELECT kind FROM lesson_feed WHERE lesson_id = ?")
			.bind(written.id)
			.first<{ kind: string }>();
		expect(feed?.kind).toBe("create");
	});

	it("refuses to write a lesson id that already exists", async () => {
		const written = lesson();
		await createLessonWithFeed(db(), userId, written);

		await expect(createLessonWithFeed(db(), userId, written)).rejects.toThrow(
			/already exists/i,
		);
	});

	// A failed write must not consume a number, or the sequence develops a hole
	// and every later contiguity check fails.
	it("consumes no sequence number when the write fails", async () => {
		const written = lesson();
		await createLessonWithFeed(db(), userId, written);

		await expect(createLessonWithFeed(db(), userId, written)).rejects.toThrow();

		expect(await createLessonWithFeed(db(), userId, lesson())).toBe(2);
	});
});

describe("getLessonById", () => {
	it("returns null for a lesson that does not exist", async () => {
		expect(await getLessonById(db(), "01KZ45MKAM734ZS7JK24D2DK99")).toBeNull();
	});
});
