import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	decodeSeqCursor,
	encodeSeqCursor,
	listActivityPage,
} from "./lessons.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

// lessons.user_id carries FOREIGN KEY (user_id) REFERENCES users(id), and this
// D1 test environment enforces it - so the brief's literal "u1"/"u2" tags need
// a real users row behind them. This maps each tag to one created user, the
// same pattern lessons-browser.test.ts and backfill.test.ts already use.
const userIds = new Map<string, string>();
async function userIdFor(tag: string): Promise<string> {
	const existing = userIds.get(tag);
	if (existing) return existing;
	const user = await createUser(db(), `${tag}@example.com`, "hash", tag);
	userIds.set(tag, user.id);
	return user.id;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	userIds.clear();
});

// A lesson row plus a feed row, so the join has something to join to. The feed
// stores no claim - it lives in the lesson's body - which is why every one of
// these seeds both.
async function seed(
	userTag: string,
	lessonId: string,
	seq: number,
	kind: string,
	at: string,
	claim: string,
) {
	const userId = await userIdFor(userTag);
	await db()
		.prepare(
			`INSERT OR IGNORE INTO lessons
			 (id, user_id, visibility, status, schema_version, body, promoted_at, created_at, updated_at)
			 VALUES (?, ?, 'private', 'active', 1, ?, ?, ?, ?)`,
		)
		.bind(
			lessonId,
			userId,
			JSON.stringify({ id: lessonId, claim, applies_to: { stack: [] } }),
			at,
			at,
			at,
		)
		.run();
	await db()
		.prepare(
			`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(seq, userId, lessonId, kind, at)
		.run();
}

describe("listActivityPage", () => {
	// The reason this orders by seq and not at. `at` defaults to
	// CURRENT_TIMESTAMP, so two events written in the same second carry the
	// same timestamp - and a tie in the sort key is how cursor pagination
	// silently drops or repeats a row across a page boundary.
	it("orders by seq when two events share a timestamp", async () => {
		const t = "2026-08-31T10:00:00Z";
		await seed("u1", "l1", 1, "create", t, "first");
		await seed("u1", "l2", 2, "create", t, "second");
		await seed("u1", "l3", 3, "status", t, "third");

		const page = await listActivityPage(db(), await userIdFor("u1"), {
			limit: 50,
		});
		expect(page.events.map((e) => e.seq)).toEqual([3, 2, 1]);
	});

	// The security boundary. lesson_feed is per-user and the join is where a
	// missing predicate would hand one account another account's claims.
	it("never returns another user's events", async () => {
		await seed("u1", "l1", 1, "create", "2026-08-31T10:00:00Z", "mine");
		await seed("u2", "l2", 1, "create", "2026-08-31T10:00:00Z", "theirs");

		const page = await listActivityPage(db(), await userIdFor("u1"), {
			limit: 50,
		});
		expect(page.events).toHaveLength(1);
		expect(page.events[0].claim).toBe("mine");
	});

	it("pages through with a cursor without dropping or repeating a row", async () => {
		for (let i = 1; i <= 5; i++) {
			await seed("u1", `l${i}`, i, "create", "2026-08-31T10:00:00Z", `c${i}`);
		}

		const userId = await userIdFor("u1");
		const first = await listActivityPage(db(), userId, { limit: 2 });
		expect(first.events.map((e) => e.seq)).toEqual([5, 4]);
		expect(first.hasMore).toBe(true);

		const second = await listActivityPage(db(), userId, {
			cursor: first.cursor,
			limit: 2,
		});
		expect(second.events.map((e) => e.seq)).toEqual([3, 2]);

		const third = await listActivityPage(db(), userId, {
			cursor: second.cursor,
			limit: 2,
		});
		expect(third.events.map((e) => e.seq)).toEqual([1]);
		expect(third.hasMore).toBe(false);
		expect(third.cursor).toBeNull();
	});

	it("carries the lesson's claim and status onto the event", async () => {
		await seed("u1", "l1", 1, "status", "2026-08-31T10:00:00Z", "a claim");
		const page = await listActivityPage(db(), await userIdFor("u1"), {
			limit: 50,
		});
		expect(page.events[0].claim).toBe("a claim");
		expect(page.events[0].kind).toBe("status");
		expect(page.events[0].lesson_id).toBe("l1");
	});
});

describe("seq cursors", () => {
	it("round-trips a sequence", () => {
		expect(decodeSeqCursor(encodeSeqCursor(42))).toBe(42);
	});

	// A client-supplied cursor is untrusted input. Malformed is a 400 upstream,
	// which needs null here rather than a throw.
	it("returns null for anything it did not issue", () => {
		expect(decodeSeqCursor("not-base64!!")).toBeNull();
		expect(decodeSeqCursor(btoa("not a number"))).toBeNull();
	});
});
