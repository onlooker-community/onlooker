import { env } from "cloudflare:test";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { lesson, resetLessonCounter } from "../test-support/lessons.js";
import {
	createLessonsWithFeed,
	getLessonForUser,
	listLessonsPage,
} from "./lessons.js";
import { addMembership, createOrgWithOwner } from "./orgs.js";
import { MAX_READER_ORGS_BOUND, readPool, readPoolLesson } from "./pool.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let mine: string;
let theirs: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM org_memberships").run();
	await db().prepare("DELETE FROM orgs").run();
	await db().prepare("DELETE FROM users").run();
	mine = (await createUser(db(), "mine@example.com", "hash", "Ada")).id;
	theirs = (await createUser(db(), "theirs@example.com", "hash", "Bob")).id;
	// lessons.org_id carries a real FK to orgs(id) (migration 0011), so any
	// literal org id this file hands to seedFor as a value actually stored
	// in the row - "org-a" below - has to exist as a row first. Ids that
	// only ever appear inside a resolver's returned list (never inserted,
	// only bound into the predicate's `IN (...)`) need no such row - that is
	// why "org-b" and the padding ids in the truncation test are never
	// created here.
	await db()
		.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
		.bind("org-a", "org-a")
		.run();
	resetLessonCounter();
});

/**
 * Seed one lesson owned by `owner`.
 *
 * Bypasses push. Still necessary even now that the gate admits `public`:
 * `org` and `retracted` cannot be pushed at all, and a split-jury public
 * lesson is refused at ingest, so most subjects here are unreachable through
 * the route. The push-to-read chain has its own test, in
 * routes/lessons-public.test.ts.
 */
async function seedFor(
	owner: string,
	overrides: Record<string, unknown>,
	orgId: string | null = null,
): Promise<TLesson> {
	const written = lesson(overrides) as TLesson;
	await createLessonsWithFeed(db(), owner, [written], orgId);
	return written;
}

async function block(authorKey: string): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO lesson_author_blocks (author_key, reason, blocked_by)
			 VALUES (?, 'injection', 'operator-1')`,
		)
		.bind(authorKey)
		.run();
}

const idsIn = (page: { lessons: unknown[] }) =>
	(page.lessons as Array<{ id: string }>).map((l) => l.id);

describe("readPool, anonymous", () => {
	it("returns a public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	// THE LEAK TESTS. Each must be proven by ablation - see Step 5.
	it("does not return a private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return an org lesson", async () => {
		await seedFor(theirs, { visibility: "org" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a retracted public lesson", async () => {
		await seedFor(theirs, { visibility: "public", status: "retracted" });
		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return a public lesson from a blocked author", async () => {
		await seedFor(theirs, { visibility: "public", author_key: "d".repeat(32) });
		await block("d".repeat(32));

		const page = await readPool(db(), null, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});
});

describe("readPool, authenticated", () => {
	it("returns my own lesson at any status", async () => {
		const retracted = await seedFor(mine, { status: "retracted" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([retracted.id]);
	});

	it("returns my own lesson even when my author_key is blocked", async () => {
		// A block stops a lesson reaching OTHER people. It is not a punishment
		// that hides your own writing from you.
		const own = await seedFor(mine, { author_key: "e".repeat(32) });
		await block("e".repeat(32));

		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([own.id]);
	});

	it("does not return another user's private lesson", async () => {
		await seedFor(theirs, { visibility: "private" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	// The authenticated-non-owner axis: a signed-in caller who is not the
	// owner. Distinct from both the anonymous leak tests above (principal is
	// null, so `own` is the literal 0) and the owner tests below (`own` is
	// true by construction) - only this axis exercises the `own` disjunct's
	// left side actually evaluating false for a real, authenticated user. A
	// bug that widened `own` to match any signed-in caller would pass every
	// other test in this file.
	it("does not return another user's retracted public lesson", async () => {
		await seedFor(theirs, { visibility: "public", status: "retracted" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return another user's public lesson from a blocked author", async () => {
		await seedFor(theirs, { visibility: "public", author_key: "f".repeat(32) });
		await block("f".repeat(32));

		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("does not return another user's org lesson to a reader in no orgs", async () => {
		await seedFor(theirs, { visibility: "org" }, "org-a");
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([]);
	});

	it("returns another user's public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const page = await readPool(db(), { userId: mine }, { limit: 50 });
		expect(idsIn(page)).toEqual([pub.id]);
	});

	it("returns an org lesson to a reader in that org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		expect(idsIn(page)).toEqual([shared.id]);
	});

	it("does not return an org lesson to a reader in a different org", async () => {
		await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-b"],
		);

		expect(idsIn(page)).toEqual([]);
	});

	it("does not leak an org lesson to a reader who shares only a DIFFERENT org with its author", async () => {
		// The bug this stage fixes, in the shape it actually had. Alice belongs
		// to orgs A and B; the lesson is shared with A; Carol belongs to B
		// only. Carol and Alice share an org, which is exactly what the old
		// predicate keyed on - it bound the reader's org-MATES against
		// lessons.user_id, so sharing ANY org with the author was enough.
		//
		// Through listLessonsPage rather than readPool, because the resolver's
		// semantics are half the bug. A test that injects its own resolver can
		// only ablate the predicate, and the predicate reverted without the
		// resolver binds org ids against user_id, matches nobody, and fails
		// closed - which is why the version of this test that injected a
		// resolver could not fail.
		const alice = (await createUser(db(), "alice@example.com", "hash", "Alice"))
			.id;
		const carol = (await createUser(db(), "carol@example.com", "hash", "Carol"))
			.id;
		const bob = (await createUser(db(), "bob@example.com", "hash", "Bob")).id;
		const orgA = await createOrgWithOwner(db(), "Org A", alice);
		const orgB = await createOrgWithOwner(db(), "Org B", alice);
		await addMembership(db(), orgA.id, bob, "member");
		await addMembership(db(), orgB.id, carol, "member");

		const sharedWithA = await seedFor(alice, { visibility: "org" }, orgA.id);

		// Carol shares org B with Alice and nothing else. She must see nothing.
		expect(idsIn(await listLessonsPage(db(), carol, { limit: 50 }))).toEqual(
			[],
		);

		// The positive half, so this cannot pass by the fixture being empty or
		// the lesson being unreadable to everyone: Bob, in org A, does see it.
		expect(idsIn(await listLessonsPage(db(), bob, { limit: 50 }))).toEqual([
			sharedWithA.id,
		]);
	});

	it("matches nothing for an org lesson with a NULL org_id", async () => {
		// The fail-closed property of `org_id IN (...)`: never true for NULL.
		// An 'org' row that somehow lacks an org is unreadable rather than
		// broadly readable.
		await seedFor(theirs, { visibility: "org" }, null);

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a", "org-b"],
		);

		expect(idsIn(page)).toEqual([]);
	});

	it("still hides a private lesson from a reader in the same org", async () => {
		// Org membership widens `org`, never `private`. lessons.ts refuses to
		// stamp org_id on anything but an 'org' row, so this state is not
		// reachable through seedFor - it is built by hand here, writing the
		// column directly, to prove the predicate itself requires
		// `visibility = 'org'` and not merely an org_id match.
		const priv = await seedFor(theirs, { visibility: "private" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind("org-a", priv.id)
			.run();

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		expect(idsIn(page)).toEqual([]);
	});

	it("narrows rather than widens when the resolver throws", async () => {
		// The never-throw contract, observed rather than assumed. A membership
		// outage must not take down a read that also serves the caller's own
		// lessons, and must not widen one.
		const own = await seedFor(mine, { visibility: "private" });
		await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => {
				throw new Error("org_memberships is unavailable");
			},
		);

		expect(idsIn(page)).toEqual([own.id]);
	});

	it("truncates an oversized reader-org list rather than binding it all", async () => {
		// MAX_READER_ORGS_BOUND keeps the `IN (...)` list under D1's
		// bound-parameter cap. Naming the lesson's org past the bound proves
		// the excess is dropped rather than the query breaking.
		await seedFor(theirs, { visibility: "org" }, "org-a");
		const padding = Array.from(
			{ length: MAX_READER_ORGS_BOUND },
			(_, i) => `padding-${i}`,
		);

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [...padding, "org-a"],
		);

		expect(idsIn(page)).toEqual([]);
	});
});

describe("listLessonsPage", () => {
	it("resolves the reader's orgs", async () => {
		// Through the production entry point, not readPool: this is the test
		// that catches a forgotten resolver argument, which is otherwise a
		// silent narrowing nothing fails on.
		const ada = (await createUser(db(), "ada2@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		const page = await listLessonsPage(db(), mine, { limit: 50 });

		expect(idsIn(page)).toEqual([shared.id]);
	});
});

describe("readPoolLesson", () => {
	it("returns a public lesson to an anonymous caller", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });
		const found = await readPoolLesson(db(), null, pub.id);
		expect((found as { id: string }).id).toBe(pub.id);
	});

	it("returns null for a private lesson to an anonymous caller", async () => {
		const priv = await seedFor(theirs, { visibility: "private" });
		expect(await readPoolLesson(db(), null, priv.id)).toBeNull();
	});

	it("returns null for a missing id, indistinguishably", async () => {
		expect(
			await readPoolLesson(db(), null, "01NOPE00000000000000000000"),
		).toBeNull();
	});

	it("returns an org lesson to a reader in that org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const found = await readPoolLesson(
			db(),
			{ userId: mine },
			shared.id,
			async () => ["org-a"],
		);

		expect((found as { id: string }).id).toBe(shared.id);
	});

	it("returns null for an org lesson to a reader in a different org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const found = await readPoolLesson(
			db(),
			{ userId: mine },
			shared.id,
			async () => ["org-b"],
		);

		expect(found).toBeNull();
	});
});

describe("getLessonForUser", () => {
	it("resolves the reader's orgs", async () => {
		// Through the production entry point, not readPoolLesson directly:
		// this is what catches a dropped fourth argument at the call site,
		// which otherwise silently narrows every org-tier single-lesson read
		// to nothing and nothing fails on it.
		const ada = (await createUser(db(), "ada3@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), mine, shared.id);

		expect(found).not.toBeNull();
		expect((found?.lesson as { id: string }).id).toBe(shared.id);
		expect(found?.own).toBe(false);
	});
});
