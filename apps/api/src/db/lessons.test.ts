import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createLessonsWithFeed,
	getLessonById,
	getLessonsByIds,
} from "./lessons.js";
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

/** The seq each lesson in a batch was assigned, or null where none was. */
async function seqs(
	forUser: string,
	...written: TLesson[]
): Promise<Array<number | null>> {
	const writes = await createLessonsWithFeed(db(), forUser, written);
	return writes.map((write) =>
		write.outcome === "created" ? write.seq : null,
	);
}

describe("createLessonsWithFeed", () => {
	it("assigns the first lesson seq 1", async () => {
		expect(await seqs(userId, lesson())).toEqual([1]);
	});

	// The property the whole delta protocol rests on. If seq has holes, the
	// client's contiguity check reports corruption on healthy data.
	it("assigns a dense sequence across separate calls", async () => {
		const assigned = [
			...(await seqs(userId, lesson())),
			...(await seqs(userId, lesson())),
			...(await seqs(userId, lesson())),
		];

		expect(assigned).toEqual([1, 2, 3]);
	});

	// The reason the batch is the unit rather than the lesson. Assigning per
	// lesson runs a separate MAX(seq)+1 per row, so a concurrent push can take a
	// number in the middle of a batch - the pusher is told 5 and 7, advances its
	// cursor to 7 on the spec's own invitation, and never receives 6.
	it("assigns one batch a contiguous block", async () => {
		expect(await seqs(userId, lesson(), lesson(), lesson())).toEqual([1, 2, 3]);
	});

	// The interleave itself, and the only test here that discriminates against
	// per-lesson assignment. Two pushes for one user run concurrently; each
	// awaits, so both read MAX(seq) before either writes.
	//
	// Assign per lesson and this reproduces the defect verbatim: one push is told
	// 1 and 3, the other 2 and 4. The spec invites a client to advance its cursor
	// to the returned seq without a follow-up read, so the first client advances
	// to 3 and never receives 2 - and the contiguity check cannot catch it,
	// because the gap was never inside a delivered window.
	it("claims a whole block, so a concurrent push cannot interleave", async () => {
		const [one, two] = await Promise.all([
			seqs(userId, lesson(), lesson()),
			seqs(userId, lesson(), lesson()),
		]);

		expect(one[1]).toBe((one[0] ?? 0) + 1);
		expect(two[1]).toBe((two[0] ?? 0) + 1);
		expect([...one, ...two].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
			1, 2, 3, 4,
		]);
	});

	it("continues from where the previous batch stopped", async () => {
		const first = await seqs(userId, lesson(), lesson(), lesson());
		const second = await seqs(userId, lesson(), lesson());

		expect(first).toEqual([1, 2, 3]);
		expect(second).toEqual([4, 5]);

		const rows = await db()
			.prepare("SELECT seq FROM lesson_feed WHERE user_id = ? ORDER BY seq")
			.bind(userId)
			.all<{ seq: number }>();
		expect(rows.results?.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	// seq is per user, not global. A global counter would leave each user's own
	// stream full of gaps wherever anyone else wrote.
	it("counts separately for each user", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");

		await seqs(userId, lesson(), lesson());

		expect(await seqs(other.id, lesson())).toEqual([1]);
	});

	it("writes every body and every feed row together", async () => {
		const one = lesson();
		const two = lesson();
		await seqs(userId, one, two);

		const stored = await getLessonsByIds(db(), [one.id, two.id]);
		expect(stored.get(one.id)?.user_id).toBe(userId);
		expect(JSON.parse(stored.get(one.id)?.body ?? "{}").claim).toBe(one.claim);
		expect(JSON.parse(stored.get(two.id)?.body ?? "{}").claim).toBe(two.claim);

		const feed = await db()
			.prepare("SELECT lesson_id, kind FROM lesson_feed ORDER BY seq")
			.all<{ lesson_id: string; kind: string }>();
		expect(feed.results).toEqual([
			{ lesson_id: one.id, kind: "create" },
			{ lesson_id: two.id, kind: "create" },
		]);
	});

	// A race must be reconcilable, not fatal. The caller cannot tell "someone
	// took this id a millisecond ago" from "it was already there", and it should
	// not have to: both end at the same re-read.
	it("reports an id that is already taken rather than throwing", async () => {
		const written = lesson();
		await seqs(userId, written);

		expect(await seqs(userId, written)).toEqual([null]);
	});

	// The whole batch rolls back on an id collision, so the surviving lessons
	// re-run together and still receive a contiguous block.
	it("writes the rest of a batch when one id is taken", async () => {
		const taken = lesson();
		await seqs(userId, taken);

		expect(await seqs(userId, lesson(), taken, lesson())).toEqual([2, null, 3]);

		const rows = await db()
			.prepare("SELECT seq FROM lesson_feed WHERE user_id = ? ORDER BY seq")
			.bind(userId)
			.all<{ seq: number }>();
		expect(rows.results?.map((row) => row.seq)).toEqual([1, 2, 3]);
	});

	// A failed write must not consume a number, or the sequence develops a hole
	// and every later contiguity check fails.
	it("consumes no sequence number when the write fails", async () => {
		const written = lesson();
		await seqs(userId, written);

		await seqs(userId, written);

		expect(await seqs(userId, lesson())).toEqual([2]);
	});

	it("writes nothing for an empty batch", async () => {
		expect(await seqs(userId)).toEqual([]);

		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed")
			.first<{ n: number }>();
		expect(feed?.n).toBe(0);
	});
});

describe("getLessonsByIds", () => {
	it("returns null for a lesson that does not exist", async () => {
		expect(await getLessonById(db(), "01KZ45MKAM734ZS7JK24D2DK99")).toBeNull();
	});

	it("answers for many ids at once, omitting the absent ones", async () => {
		const one = lesson();
		const two = lesson();
		await seqs(userId, one, two);

		const found = await getLessonsByIds(db(), [
			one.id,
			"01KZ45MKAM734ZS7JK24D2DK99",
			two.id,
		]);

		expect([...found.keys()].sort()).toEqual([one.id, two.id].sort());
	});

	it("returns an empty map for no ids", async () => {
		expect((await getLessonsByIds(db(), [])).size).toBe(0);
	});
});
