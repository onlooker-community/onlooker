import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import {
	accountDeletionPreview,
	createLessonsWithFeed,
	hasOrgSharedLessons,
	isUniqueViolationOn,
	nonOrgLessonsDelete,
	probeLessonId,
	probeLessonIds,
	readLessonDelta,
	retractOrgLesson,
	transitionLesson,
} from "./lessons.js";
import { createOrgWithOwner } from "./orgs.js";
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

		const stored = await probeLessonIds(db(), [one.id, two.id]);
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

describe("createLessonsWithFeed and the lesson's org", () => {
	const orgIdOf = async (id: string) =>
		(
			await db()
				.prepare("SELECT org_id FROM lessons WHERE id = ?")
				.bind(id)
				.first<{ org_id: string | null }>()
		)?.org_id ?? null;

	it("stamps the org on an org-visible lesson", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), userId, [written], org.id);

		expect(await orgIdOf(written.id)).toBe(org.id);
	});

	it("leaves org_id NULL when the token names no org", async () => {
		const written = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), userId, [written], null);

		expect(await orgIdOf(written.id)).toBeNull();
	});

	it("does not stamp the org onto a private lesson in the same batch", async () => {
		// The org is the TOKEN's, and a batch may mix tiers. A private row
		// carrying an org_id is invisible to the org - the predicate also
		// requires visibility = 'org' - but it would be reachable by the
		// org-retract path, which authorizes on this column. An owner must not
		// be able to retract a member's private lesson.
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const priv = lesson({ visibility: "private" }) as TLesson;
		const shared = lesson({ visibility: "org" }) as TLesson;

		await createLessonsWithFeed(db(), userId, [priv, shared], org.id);

		expect(await orgIdOf(priv.id)).toBeNull();
		expect(await orgIdOf(shared.id)).toBe(org.id);
	});

	it("reports the org through probeLessonIds", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);

		const found = await probeLessonIds(db(), [written.id]);

		expect(found.get(written.id)?.org_id).toBe(org.id);
	});
});

describe("readLessonDelta", () => {
	// The same implicit invariant `listActivityPage` rests on, in the other
	// query that joins the feed to `lessons`. `lessons.id` is a global primary
	// key, so joining on it alone hands over whatever lesson a feed row names,
	// whoever owns it.
	//
	// Broken directly here, because no writer breaks it: this batch drops a
	// colliding id from pending and writes no feed row for it, and
	// `transitionLesson` returns null before writing when the owner differs.
	// The failure mode a future writer should get is no rows, not another
	// account's lesson body.
	it("returns nothing when a feed row points at another user's lesson", async () => {
		const other = await createUser(db(), "other@example.com", "hash", "Bo");
		const theirs = lesson();
		await createLessonsWithFeed(db(), other.id, [theirs]);

		await db()
			.prepare(
				`INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at)
				 VALUES (?, ?, ?, 'create', ?)`,
			)
			.bind(1, userId, theirs.id, "2026-08-22T00:00:00.000Z")
			.run();

		const { entries } = await readLessonDelta(db(), userId, 0, 50);

		expect(entries).toEqual([]);
	});
});

describe("probeLessonIds", () => {
	it("returns null for a lesson that does not exist", async () => {
		expect(await probeLessonId(db(), "01KZ45MKAM734ZS7JK24D2DK99")).toBeNull();
	});

	it("answers for many ids at once, omitting the absent ones", async () => {
		const one = lesson();
		const two = lesson();
		await seqs(userId, one, two);

		const found = await probeLessonIds(db(), [
			one.id,
			"01KZ45MKAM734ZS7JK24D2DK99",
			two.id,
		]);

		expect([...found.keys()].sort()).toEqual([one.id, two.id].sort());
	});

	it("returns an empty map for no ids", async () => {
		expect((await probeLessonIds(db(), [])).size).toBe(0);
	});

	it("finds a lesson owned by someone else, which push depends on", async () => {
		// If a user_id filter is ever added here, push stops detecting that an
		// id is taken by another account and mints a duplicate. This test is the
		// tripwire for that.
		const other = await createUser(db(), "other@example.com", "hash", "Bob");
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), other.id, [written]);

		const found = await probeLessonIds(db(), [written.id]);

		expect(found.get(written.id)?.user_id).toBe(other.id);
	});
});

// The retry-or-500 decision hangs entirely on D1's error TEXT, a vendor string
// nothing in the build pins. The lesson_feed branch is the acknowledged
// untestable concurrency path - but its TRIGGER is testable, and if D1 ever
// reformats these messages every concurrent push 500s instead of retrying.
//
// The wrapped forms are the literal strings this repository's D1 emits, read
// off a real collision; the bare forms are what SQLite itself produces.
describe("isUniqueViolationOn", () => {
	const LESSON_ID = "UNIQUE constraint failed: lessons.id";
	const FEED = "UNIQUE constraint failed: lesson_feed.user_id, lesson_feed.seq";
	const WRAPPED_LESSON_ID = `D1_ERROR: ${LESSON_ID}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`;
	const WRAPPED_FEED = `D1_ERROR: ${FEED}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`;

	it("classifies a lessons.id collision", () => {
		expect(isUniqueViolationOn(new Error(LESSON_ID), "lessons.id")).toBe(true);
		expect(
			isUniqueViolationOn(new Error(WRAPPED_LESSON_ID), "lessons.id"),
		).toBe(true);
	});

	it("classifies a lesson_feed collision", () => {
		expect(isUniqueViolationOn(new Error(FEED), "lesson_feed")).toBe(true);
		expect(isUniqueViolationOn(new Error(WRAPPED_FEED), "lesson_feed")).toBe(
			true,
		);
	});

	// Cross-matching is what turns a retryable sequence collision into a fatal
	// "id already taken", or the reverse - each answers the other's question.
	it("does not cross-match the other table", () => {
		expect(isUniqueViolationOn(new Error(LESSON_ID), "lesson_feed")).toBe(
			false,
		);
		expect(
			isUniqueViolationOn(new Error(WRAPPED_LESSON_ID), "lesson_feed"),
		).toBe(false);
		expect(isUniqueViolationOn(new Error(FEED), "lessons.id")).toBe(false);
		expect(isUniqueViolationOn(new Error(WRAPPED_FEED), "lessons.id")).toBe(
			false,
		);
	});

	it("classifies an unrelated failure as neither", () => {
		const other = new Error("D1_ERROR: no such table: lessons: SQLITE_ERROR");

		expect(isUniqueViolationOn(other, "lessons.id")).toBe(false);
		expect(isUniqueViolationOn(other, "lesson_feed")).toBe(false);
	});

	it("classifies a NOT NULL failure on the same table as neither", () => {
		const notNull = new Error(
			"D1_ERROR: NOT NULL constraint failed: lesson_feed.seq: SQLITE_CONSTRAINT",
		);

		expect(isUniqueViolationOn(notNull, "lesson_feed")).toBe(false);
	});

	it("survives a thrown value that is not an Error", () => {
		expect(isUniqueViolationOn(LESSON_ID, "lessons.id")).toBe(false);
		expect(isUniqueViolationOn(null, "lessons.id")).toBe(false);
	});
});

describe("promoted_at", () => {
	it("is stored in the column, not only inside the body", async () => {
		const written = lesson({ promoted_at: "2026-08-14T09:30:00.000Z" });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT promoted_at FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ promoted_at: string }>();
		expect(row?.promoted_at).toBe("2026-08-14T09:30:00.000Z");
	});

	// The column and the body are two copies of one fact. They are written in
	// the same statement so they cannot diverge, and this is the assertion
	// that would catch it if the INSERT ever stopped binding one of them.
	it("agrees with the copy inside the body", async () => {
		const written = lesson({ promoted_at: "2026-08-14T09:30:00.000Z" });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT promoted_at, body FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ promoted_at: string; body: string }>();
		expect(row?.promoted_at).toBe(
			(JSON.parse(row?.body ?? "{}") as { promoted_at: string }).promoted_at,
		);
	});
});

describe("author_key", () => {
	it("is stored in the column, not only inside the body", async () => {
		const written = lesson({ author_key: "f".repeat(32) });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT author_key FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ author_key: string }>();
		expect(row?.author_key).toBe("f".repeat(32));
	});

	// The column and the body are two copies of one fact. They are written in
	// the same statement so they cannot diverge, and this is the assertion
	// that would catch it if the INSERT ever stopped binding one of them.
	it("agrees with the copy inside the body", async () => {
		const written = lesson({ author_key: "f".repeat(32) });

		await createLessonsWithFeed(db(), userId, [written]);

		const row = await db()
			.prepare("SELECT author_key, body FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ author_key: string; body: string }>();
		expect(row?.author_key).toBe(
			(JSON.parse(row?.body ?? "{}") as { author_key: string }).author_key,
		);
	});
});

describe("retractOrgLesson", () => {
	it("retracts a lesson shared with that org", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);

		const seq = await retractOrgLesson(db(), org.id, written.id);

		expect(seq).not.toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("retracted");
	});

	it("refuses a lesson shared with a different org", async () => {
		// An owner of org B must not reach inside org A.
		const orgA = await createOrgWithOwner(db(), "Acme", userId);
		const orgB = await createOrgWithOwner(db(), "Beta", userId);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], orgA.id);

		expect(await retractOrgLesson(db(), orgB.id, written.id)).toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("active");
	});

	it("refuses a private lesson, even one carrying an org_id", async () => {
		// Defense in depth with the write-side rule in createLessonsWithFeed:
		// if a private row ever acquires an org_id, this path still refuses it.
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "private" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(org.id, written.id)
			.run();

		expect(await retractOrgLesson(db(), org.id, written.id)).toBeNull();
		expect((await probeLessonId(db(), written.id))?.status).toBe("active");
	});

	it("appends to the AUTHOR's feed, not the retracting owner's", async () => {
		// D6: a member authors an org lesson and an owner retracts it. The
		// author's mirror is what needs to learn the lesson is gone, so the
		// owner here is a genuinely different id from the author - otherwise
		// nothing would distinguish "the author's feed" from "the owner's
		// feed" and this test would pass no matter which one the write
		// actually targeted.
		const owner = await createUser(db(), "owner@example.com", "hash", "Bo");
		const org = await createOrgWithOwner(db(), "Acme", owner.id);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);

		await retractOrgLesson(db(), org.id, written.id);

		const row = await db()
			.prepare(
				"SELECT user_id FROM lesson_feed WHERE lesson_id = ? AND kind = 'status'",
			)
			.bind(written.id)
			.first<{ user_id: string }>();
		expect(row?.user_id).toBe(userId);
		expect(row?.user_id).not.toBe(owner.id);
	});

	it("returns null for an id that does not exist", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		expect(
			await retractOrgLesson(db(), org.id, "01NOPE00000000000000000000"),
		).toBeNull();
	});
});

describe("hasOrgSharedLessons", () => {
	// Neither `orgId` nor `other` is in scope at the top of this file, so this
	// describe mints its own - `author` is just this file's existing `userId`,
	// named to match the brief's tests.
	let author: string;
	let other: string;
	let orgId: string;

	beforeEach(async () => {
		author = userId;
		other = (await createUser(db(), "cleo@example.com", "hash", "Cleo")).id;
		orgId = (await createOrgWithOwner(db(), "Acme", author)).id;
	});

	it("is true for a lesson shared with an org", async () => {
		await createLessonsWithFeed(
			db(),
			author,
			[lesson({ visibility: "org" })],
			orgId,
		);
		expect(await hasOrgSharedLessons(db(), author)).toBe(true);
	});

	it("is false for public and private lessons only", async () => {
		await createLessonsWithFeed(
			db(),
			author,
			[lesson({ visibility: "public" }), lesson({ visibility: "private" })],
			null,
		);
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});

	it("is false for an org lesson whose org is gone", async () => {
		// org_id is ON DELETE SET NULL, so such a row is readable by nobody and
		// must not keep an account alive as its anchor.
		await createLessonsWithFeed(
			db(),
			author,
			[lesson({ visibility: "org" })],
			orgId,
		);
		await db()
			.prepare("UPDATE lessons SET org_id = NULL WHERE user_id = ?")
			.bind(author)
			.run();
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});

	it("is false for another user's org lesson", async () => {
		await createLessonsWithFeed(
			db(),
			other,
			[lesson({ visibility: "org" })],
			orgId,
		);
		expect(await hasOrgSharedLessons(db(), author)).toBe(false);
	});
});

describe("nonOrgLessonsDelete", () => {
	let author: string;
	let other: string;
	let orgId: string;

	beforeEach(async () => {
		author = userId;
		other = (await createUser(db(), "cleo@example.com", "hash", "Cleo")).id;
		orgId = (await createOrgWithOwner(db(), "Acme", author)).id;
	});

	// The statement is gated on its subject already being anonymized, because
	// Task 3 runs it in the same batch as the UPDATE that sets that column.
	// These tests set it directly, which is also what the real caller's
	// transaction makes true by the time the statement runs.
	const anonymize = (userId: string) =>
		db()
			.prepare("UPDATE users SET anonymized_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), userId)
			.run();

	it("deletes public and private lessons and keeps org ones", async () => {
		// meta.changes is not asserted here: D1 folds lesson_feed's
		// ON DELETE CASCADE rows into it (measured below), so it counts
		// something other than "how many lessons survived". The id check
		// below is strictly stronger anyway - it names exactly which rows
		// remain rather than counting them.
		await createLessonsWithFeed(
			db(),
			author,
			[lesson({ visibility: "public" }), lesson({ visibility: "private" })],
			null,
		);
		const kept = lesson({ visibility: "org" });
		await createLessonsWithFeed(db(), author, [kept], orgId);
		await anonymize(author);

		await nonOrgLessonsDelete(db(), author).run();

		const rows = await db()
			.prepare("SELECT id FROM lessons WHERE user_id = ?")
			.bind(author)
			.all<{ id: string }>();
		expect(rows.results?.map((r) => r.id)).toEqual([kept.id]);
	});

	it("deletes an org lesson whose org is gone", async () => {
		const written = lesson({ visibility: "org" });
		await createLessonsWithFeed(db(), author, [written], orgId);
		await db()
			.prepare("UPDATE lessons SET org_id = NULL WHERE user_id = ?")
			.bind(author)
			.run();
		await anonymize(author);

		await nonOrgLessonsDelete(db(), author).run();
		expect(await probeLessonId(db(), written.id)).toBeNull();
	});

	it("takes the deleted lessons' feed rows with them", async () => {
		await createLessonsWithFeed(
			db(),
			author,
			[lesson({ visibility: "public" })],
			null,
		);
		await anonymize(author);

		// lesson_feed.lesson_id cascades from lessons, so this needs no code of
		// its own - but it is why the anonymize path can keep the author's
		// remaining feed rows without keeping dead ones.
		await nonOrgLessonsDelete(db(), author).run();
		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed WHERE user_id = ?")
			.bind(author)
			.first<{ n: number }>();
		expect(feed?.n).toBe(0);
	});

	it("does nothing while the account is not anonymized", async () => {
		const written = lesson({ visibility: "public" });
		await createLessonsWithFeed(db(), author, [written], null);

		// The gate. In Task 3 this is what keeps a refused sole-owner guard
		// from leaving an account with its lessons deleted and its identity
		// intact. meta.changes alone would also pass if the statement had
		// deleted the row and merely reported the count wrong, so the row's
		// survival is asserted directly too.
		const result = await nonOrgLessonsDelete(db(), author).run();
		expect(result.meta.changes).toBe(0);
		expect(await probeLessonId(db(), written.id)).not.toBeNull();
	});

	it("leaves another user's lessons alone", async () => {
		await createLessonsWithFeed(
			db(),
			other,
			[lesson({ visibility: "public" })],
			null,
		);
		await anonymize(author);

		const result = await nonOrgLessonsDelete(db(), author).run();
		expect(result.meta.changes).toBe(0);
	});
});

describe("accountDeletionPreview", () => {
	it("counts public lessons and keeps org ones out of that count", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "org" }) as TLesson],
			org.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(1);
		expect(preview.orgsKeeping).toEqual([
			{ id: org.id, name: "Acme", lessons: 1 },
		]);
	});

	it("groups each org separately, ordered by name", async () => {
		const beta = await createOrgWithOwner(db(), "Beta", userId);
		const acme = await createOrgWithOwner(db(), "Acme", userId);
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "org" }) as TLesson],
			beta.id,
		);
		await createLessonsWithFeed(
			db(),
			userId,
			[
				lesson({ visibility: "org" }) as TLesson,
				lesson({ visibility: "org" }) as TLesson,
			],
			acme.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		// Acme first, matching soleOwnedOrgs' ORDER BY o.name (orgs.ts:417), so
		// the two lists somebody may see minutes apart agree.
		expect(preview.orgsKeeping).toEqual([
			{ id: acme.id, name: "Acme", lessons: 2 },
			{ id: beta.id, name: "Beta", lessons: 1 },
		]);
	});

	it("leaves retracted lessons out of both counts", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const published = lesson({ visibility: "public" }) as TLesson;
		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [published], null);
		await createLessonsWithFeed(db(), userId, [shared], org.id);
		// pool.ts:160 hides a retracted lesson from everybody but its author, so
		// it is already withdrawn: counting it would overstate what deletion
		// costs anybody else, and claiming the org keeps it would be worse.
		await db()
			.prepare("UPDATE lessons SET status = 'retracted' WHERE id IN (?, ?)")
			.bind(published.id, shared.id)
			.run();

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(0);
		expect(preview.orgsKeeping).toEqual([]);
	});

	it("still counts a superseded lesson, which readers can still reach", async () => {
		await createLessonsWithFeed(
			db(),
			userId,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await db()
			.prepare("UPDATE lessons SET status = 'superseded' WHERE user_id = ?")
			.bind(userId)
			.run();

		expect((await accountDeletionPreview(db(), userId)).publicLessons).toBe(1);
	});

	it("counts nobody else's lessons", async () => {
		const other = await createUser(db(), "bob@example.com", "hash", "Bob");
		const org = await createOrgWithOwner(db(), "Acme", other.id);
		await createLessonsWithFeed(
			db(),
			other.id,
			[lesson({ visibility: "public" }) as TLesson],
			null,
		);
		await createLessonsWithFeed(
			db(),
			other.id,
			[lesson({ visibility: "org" }) as TLesson],
			org.id,
		);

		const preview = await accountDeletionPreview(db(), userId);

		expect(preview.publicLessons).toBe(0);
		expect(preview.orgsKeeping).toEqual([]);
	});

	it("answers zero and empty for an account that has shared nothing", async () => {
		expect(await accountDeletionPreview(db(), userId)).toEqual({
			publicLessons: 0,
			orgsKeeping: [],
		});
	});
});

/** How many feed rows exist for one lesson, and the newest seq among them. */
async function feedFor(lessonId: string): Promise<{
	rows: number;
	latest: number | null;
}> {
	const row = await db()
		.prepare(
			"SELECT COUNT(*) AS rows, MAX(seq) AS latest FROM lesson_feed WHERE lesson_id = ?",
		)
		.bind(lessonId)
		.first<{ rows: number; latest: number | null }>();
	return { rows: row?.rows ?? 0, latest: row?.latest ?? null };
}

describe("a transition that changes nothing", () => {
	it("writes no second feed row and answers with the existing seq", async () => {
		const org = await createOrgWithOwner(db(), "Acme", userId);
		const written = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), userId, [written], org.id);

		const first = await retractOrgLesson(db(), org.id, written.id);
		const afterFirst = await feedFor(written.id);

		const second = await retractOrgLesson(db(), org.id, written.id);

		// The point of the issue: the author's mirror must not learn about a
		// retraction twice.
		expect(second).toBe(first);
		expect(await feedFor(written.id)).toEqual(afterFirst);
	});

	it("answers with the latest status entry, not the earliest", async () => {
		// Distinguishes MAX(seq) from a first-row read. A lesson retracted,
		// reactivated and retracted again has three status entries, and the one
		// describing the state the caller asked for is the last.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);

		await transitionLesson(db(), userId, written.id, "retracted", null);
		await transitionLesson(db(), userId, written.id, "active", null);
		const third = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		const redundant = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		expect(redundant).toBe(third);
		expect((await feedFor(written.id)).latest).toBe(third);
	});

	it("still writes when only superseded_by differs", async () => {
		// `retracted` with a superseder and `retracted` with none are different
		// states, and only one of them is what a retract asks for.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);

		await transitionLesson(db(), userId, written.id, "retracted", "01OTHER");
		const before = await feedFor(written.id);

		const seq = await transitionLesson(
			db(),
			userId,
			written.id,
			"retracted",
			null,
		);

		expect(seq).not.toBe(before.latest);
		expect((await feedFor(written.id)).rows).toBe(before.rows + 1);
		const stored = await probeLessonId(db(), written.id);
		expect(
			(JSON.parse(stored?.body ?? "{}") as { superseded_by: string | null })
				.superseded_by,
		).toBeNull();
	});

	it("repairs a body whose status has drifted from its column", async () => {
		// Before this precondition existed, a redundant call happened to fix a
		// drifted body. Skipping on the column alone would preserve the drift
		// instead, so the skip requires both copies to already agree.
		const written = lesson() as TLesson;
		await createLessonsWithFeed(db(), userId, [written]);
		await transitionLesson(db(), userId, written.id, "retracted", null);

		const drifted = await probeLessonId(db(), written.id);
		const body = JSON.parse(drifted?.body ?? "{}") as Record<string, unknown>;
		body.status = "active";
		await db()
			.prepare("UPDATE lessons SET body = ? WHERE id = ?")
			.bind(JSON.stringify(body), written.id)
			.run();

		await transitionLesson(db(), userId, written.id, "retracted", null);

		const repaired = await probeLessonId(db(), written.id);
		expect(repaired?.status).toBe("retracted");
		expect(
			(JSON.parse(repaired?.body ?? "{}") as { status: string }).status,
		).toBe("retracted");
	});
});
