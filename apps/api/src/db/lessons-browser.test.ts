import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	createLessonsWithFeed,
	decodeCursor,
	encodeCursor,
	getLessonForUser,
	listLessonsPage,
} from "./lessons.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "pool@example.com", "hash", "Ada");
	userId = user.id;
	resetLessonCounter();
});

/**
 * Write lessons whose promoted_at values are given, oldest first.
 *
 * The cast is because test-support's `lesson()` returns an untyped literal so
 * callers can override any field, including invalid ones. Here every override
 * is valid, so asserting the contract type is honest rather than a workaround.
 */
async function seed(dates: string[]): Promise<TLesson[]> {
	const written = dates.map((d) => lesson({ promoted_at: d }) as TLesson);
	await createLessonsWithFeed(db(), userId, written);
	return written;
}

describe("listLessonsPage", () => {
	it("returns newest first", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
		]);

		const page = await listLessonsPage(db(), userId, { limit: 50 });

		expect(
			(page.lessons as Array<{ promoted_at: string }>).map(
				(l) => l.promoted_at,
			),
		).toEqual([
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
		expect(page.hasMore).toBe(false);
		expect(page.cursor).toBeNull();
	});

	it("walks pages without skipping or repeating a lesson", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
			"2026-08-04T00:00:00.000Z",
			"2026-08-05T00:00:00.000Z",
		]);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listLessonsPage(db(), userId, { limit: 2, cursor });
			seen.push(...(page.lessons as Array<{ id: string }>).map((l) => l.id));
			cursor = page.cursor;
		} while (cursor);

		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
	});

	// The whole reason id is in the cursor. Without it, a page boundary landing
	// between two lessons sharing a timestamp either skips or repeats one.
	it("is stable when every lesson shares a promoted_at", async () => {
		const same = "2026-08-09T00:00:00.000Z";
		await seed([same, same, same, same]);

		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listLessonsPage(db(), userId, { limit: 2, cursor });
			seen.push(...(page.lessons as Array<{ id: string }>).map((l) => l.id));
			cursor = page.cursor;
		} while (cursor);

		expect(seen).toHaveLength(4);
		expect(new Set(seen).size).toBe(4);
	});

	it("filters by status", async () => {
		const [first] = await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
		]);
		await db()
			.prepare("UPDATE lessons SET status = 'retracted' WHERE id = ?")
			.bind(first.id)
			.run();

		const page = await listLessonsPage(db(), userId, {
			limit: 50,
			statuses: ["retracted"],
		});

		expect(page.lessons).toHaveLength(1);
		expect((page.lessons[0] as { id: string }).id).toBe(first.id);
	});

	it("never returns another user's lessons", async () => {
		await seed(["2026-08-01T00:00:00.000Z"]);
		const other = await createUser(db(), "other@example.com", "hash", "Bo");

		const page = await listLessonsPage(db(), other.id, { limit: 50 });

		expect(page.lessons).toEqual([]);
	});

	it("caps the page at the requested limit and reports more", async () => {
		await seed([
			"2026-08-01T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-03T00:00:00.000Z",
		]);

		const page = await listLessonsPage(db(), userId, { limit: 2 });

		expect(page.lessons).toHaveLength(2);
		expect(page.hasMore).toBe(true);
		expect(page.cursor).not.toBeNull();
	});
});

describe("getLessonForUser", () => {
	it("returns the lesson body", async () => {
		const [written] = await seed(["2026-08-01T00:00:00.000Z"]);

		const found = await getLessonForUser(db(), userId, written.id);

		expect((found as { id: string }).id).toBe(written.id);
	});

	// 404, not 403 - a 403 would confirm the id exists.
	it("returns null for another user's lesson", async () => {
		const [written] = await seed(["2026-08-01T00:00:00.000Z"]);
		const other = await createUser(db(), "other@example.com", "hash", "Bo");

		expect(await getLessonForUser(db(), other.id, written.id)).toBeNull();
	});

	it("returns null for an id nobody holds", async () => {
		expect(
			await getLessonForUser(db(), userId, "01NOPE00000000000000000000"),
		).toBeNull();
	});
});

describe("cursor encoding", () => {
	it("round-trips", () => {
		const c = encodeCursor("2026-08-01T00:00:00.000Z", "01ABC");
		expect(decodeCursor(c)).toEqual({
			promotedAt: "2026-08-01T00:00:00.000Z",
			id: "01ABC",
		});
	});

	// A cursor is client-supplied input. Garbage must not throw a 500.
	it("returns null for a cursor that is not ours", () => {
		for (const bad of ["", "!!!!", "bm90LWEtY3Vyc29y"]) {
			expect(decodeCursor(bad)).toBeNull();
		}
	});
});
