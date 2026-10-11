import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
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

/**
 * A D1 stand-in for the D3 laziness proof: every call reaches the real
 * binding - so a page can actually carry an org-reached row - while every
 * `prepare()` is also remembered, so a test can ask which tables a call to
 * `readPool` touched.
 *
 * Not modeled on `pool-query-plan.test.ts`'s recorder as a direct copy: that
 * one answers every `all()`/`first()` with nothing at all, which is exactly
 * right for a query-PLAN test that never needs a row back, but wrong here.
 * `orgReached` is computed from the rows the main SELECT actually returns,
 * so a recorder that always answers empty can never produce a page with an
 * org-reached row - the one branch this proof needs to also show DOES run
 * the two statements, so the negative assertion is not vacuously true of a
 * fixture that cannot reach the other branch either. A Proxy over the real
 * binding is the shape that lets both halves run against one real
 * database.
 */
function spy(real: D1Database): { sqls: string[]; db: D1Database } {
	const sqls: string[] = [];
	const proxied = new Proxy(real, {
		get(target, prop, receiver) {
			if (prop === "prepare") {
				return (sql: string) => {
					sqls.push(sql);
					return target.prepare(sql);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return { sqls, db: proxied };
}

/** Whether any captured statement names this table, as a whole word. */
function anyStatementTouches(sqls: string[], table: string): boolean {
	const named = new RegExp(`\\b${table}\\b`, "i");
	return sqls.some((sql) => named.test(sql));
}

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

	it("names the org for an owner reading a teammate's org lesson", async () => {
		const owner = (await createUser(db(), "o2@example.com", "hash", "Ona")).id;
		const author = (await createUser(db(), "a2@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme Two", owner);
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), owner, shared.id);

		expect(found?.retractable_in).toEqual({
			org_id: org.id,
			org_name: "Acme Two",
		});
	});

	it("answers null for a member of the same org", async () => {
		const owner = (await createUser(db(), "o3@example.com", "hash", "Ona")).id;
		const member = (await createUser(db(), "m3@example.com", "hash", "Mem")).id;
		const author = (await createUser(db(), "a3@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme Three", owner);
		await addMembership(db(), org.id, member, "member");
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const found = await getLessonForUser(db(), member, shared.id);

		expect(found).not.toBeNull();
		expect(found?.retractable_in).toBeNull();
	});

	it("answers null for the reader's own lesson in an org they own", async () => {
		const owner = (await createUser(db(), "o4@example.com", "hash", "Ona")).id;
		const org = await createOrgWithOwner(db(), "Acme Four", owner);
		const own = await seedFor(owner, { visibility: "org" }, org.id);

		expect(
			(await getLessonForUser(db(), owner, own.id))?.retractable_in,
		).toBeNull();
	});

	it("answers null for a public lesson, even one that carries a real org_id", async () => {
		// Deliberately NOT the brief's literal fixture (a public lesson with
		// no org_id at all). That shape cannot tell "excluded because
		// visibility isn't 'org'" apart from "excluded because org_id is
		// null" - the same gap Task 2's analogous public-lesson test left,
		// caught in review. So: a real org the reader OWNS, and a public
		// lesson force-updated to carry that org's id, the same way "does not
		// name the author of a public lesson that carries an org_id" above
		// builds its fixture. Unreachable through the writer -
		// createLessonsWithFeed stamps org_id only onto 'org' rows - hence
		// the raw UPDATE.
		const owner = (await createUser(db(), "o5@example.com", "hash", "Ona")).id;
		const author = (await createUser(db(), "a5@example.com", "hash", "Al")).id;
		const org = await createOrgWithOwner(db(), "Acme Five", owner);
		const pub = await seedFor(author, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(org.id, pub.id)
			.run();

		const found = await getLessonForUser(db(), owner, pub.id);

		expect(found).not.toBeNull();
		expect(found?.retractable_in).toBeNull();
	});
});

describe("org attribution", () => {
	it("names the author of an org lesson the reader reaches through their org", async () => {
		const shared = await seedFor(theirs, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		// `theirs` was created with the name "Bob" in this suite's beforeEach.
		expect(page.authors).toEqual({ [shared.id]: "Bob" });
	});

	it("does not name the author of a public lesson", async () => {
		// A public row carries author_key alone, so the anonymous surface's
		// disclosure is unchanged and nothing links an author across tiers.
		await seedFor(theirs, { visibility: "public" });

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		expect(page.authors).toEqual({});
	});

	it("does not name the author of a public lesson that carries an org_id", async () => {
		// Unreachable through the writer - createLessonsWithFeed stamps org_id
		// only onto 'org' rows and nothing mutates visibility afterward - so
		// the row is built by hand, as "still hides a private lesson from a
		// reader in the same org" is.
		//
		// This is what makes the filter's `visibility === "org"` clause
		// load-bearing rather than merely redundant. Without a test that can
		// tell the clause's presence from its absence, a later reader deletes
		// it as dead weight with every test still green - and then a write
		// path that ever puts an org on a public row spills a name onto the
		// one tier whose disclosure guarantee is an unlinkable author_key and
		// nothing else.
		const pub = await seedFor(theirs, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind("org-a", pub.id)
			.run();

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		// The row is still returned - it is public - and still unattributed.
		expect(idsIn(page)).toContain(pub.id);
		expect(page.authors).toEqual({});
	});

	it("does not name the author of an org lesson the reader reaches as its owner", async () => {
		// Reached through `user_id = ?` rather than through the org disjunct:
		// the reader left the org, and their own lesson is still theirs to see.
		const own = await seedFor(mine, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => [],
		);

		expect(idsIn(page)).toEqual([own.id]);
		expect(page.authors).toEqual({});
	});

	it("names the reader's own org lesson in an org they still belong to", async () => {
		const own = await seedFor(mine, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		// Their own name, which is harmless and is what the filter produces:
		// the org match decides attribution, not which disjunct admitted the
		// row. `mine` was created with the name "Ada" in this suite's
		// beforeEach.
		expect(page.authors[own.id]).toBe("Ada");
	});

	it("omits the key for an author who has no name", async () => {
		// createUser's fourth parameter is `name?: string`, which does not
		// accept `null` under this repo's strict compiler settings - so the
		// nameless user is inserted directly rather than through createUser.
		const nameless = crypto.randomUUID();
		await db()
			.prepare(
				"INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, NULL)",
			)
			.bind(nameless, "no@example.com", "hash")
			.run();
		const shared = await seedFor(nameless, { visibility: "org" }, "org-a");

		const page = await readPool(
			db(),
			{ userId: mine },
			{ limit: 50 },
			async () => ["org-a"],
		);

		expect(idsIn(page)).toEqual([shared.id]);
		expect(page.authors).toEqual({});
	});

	it("is always present, even with nothing to attribute", async () => {
		// Same rule as owned_ids: a client must not have to tell "nobody is
		// named" apart from "this server does not say".
		const page = await readPool(db(), { userId: mine }, { limit: 50 });

		expect(page.authors).toEqual({});
	});
});

describe("retractable_in", () => {
	it("names the org for an owner reading a teammate's org lesson", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al"))
			.id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const page = await readPool(
			db(),
			{ userId: owner },
			{ limit: 50 },
			async () => [org.id],
		);

		expect(page.retractableIn).toEqual({
			[shared.id]: { org_id: org.id, org_name: "Acme" },
		});
	});

	// THE case this feature turns on. A member may read the lesson and must
	// not be offered a control the API would refuse.
	it("gives a MEMBER of the same org nothing", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		const member = (await createUser(db(), "member@example.com", "hash", "Mem"))
			.id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al"))
			.id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await addMembership(db(), org.id, member, "member");
		await addMembership(db(), org.id, author, "member");
		const shared = await seedFor(author, { visibility: "org" }, org.id);

		const page = await readPool(
			db(),
			{ userId: member },
			{ limit: 50 },
			async () => [org.id],
		);

		// They can read it...
		expect(idsIn(page)).toEqual([shared.id]);
		// ...and may not retract it.
		expect(page.retractableIn).toEqual({});
	});

	it("gives nothing for the reader's OWN lesson in an org they own", async () => {
		// D6: the author's bidirectional control answers for this, and two
		// controls on one lesson is worse than one.
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		const own = await seedFor(owner, { visibility: "org" }, org.id);

		const page = await readPool(
			db(),
			{ userId: owner },
			{ limit: 50 },
			async () => [org.id],
		);

		expect(idsIn(page)).toEqual([own.id]);
		expect(page.retractableIn).toEqual({});
	});

	it("gives nothing for a public lesson, whatever the reader owns", async () => {
		// Deliberately NOT a public lesson with no org_id at all - that shape
		// cannot tell "excluded because visibility isn't 'org'" apart from
		// "excluded because org_id is null", so an ablation of the
		// `r.visibility === "org"` clause at pool.ts:277 would still pass
		// this test. A real org the reader OWNS, and a public lesson
		// force-updated to carry that org's id, the same way "answers null
		// for a public lesson, even one that carries a real org_id" below
		// (getLessonForUser's equivalent) and the ONL-141 attribution
		// fixture both build theirs. Unreachable through the writer -
		// createLessonsWithFeed stamps org_id only onto 'org' rows - hence
		// the raw UPDATE.
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al"))
			.id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		const pub = await seedFor(author, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind(org.id, pub.id)
			.run();

		const page = await readPool(
			db(),
			{ userId: owner },
			{ limit: 50 },
			async () => [org.id],
		);

		expect(page.retractableIn).toEqual({});
	});

	it("is always present, even with nothing to retract", async () => {
		// Same rule as owned_ids and authors: a client must not have to tell
		// "nothing is retractable" from "this server does not say".
		const page = await readPool(db(), { userId: mine }, { limit: 50 });

		expect(page.retractableIn).toEqual({});
	});

	// Not required by the brief, but cheap once the fixture exists: a reader
	// who OWNS one org and is only a MEMBER of another gets an entry for
	// exactly the lesson in the org they own.
	it("gives an entry only for the org the reader owns, not the one they merely belong to", async () => {
		const reader = (await createUser(db(), "reader@example.com", "hash", "Rea"))
			.id;
		const otherOwner = (
			await createUser(db(), "other-owner@example.com", "hash", "Oth")
		).id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al"))
			.id;
		const owned = await createOrgWithOwner(db(), "Acme", reader);
		const memberOf = await createOrgWithOwner(db(), "Globex", otherOwner);
		await addMembership(db(), owned.id, author, "member");
		await addMembership(db(), memberOf.id, reader, "member");
		await addMembership(db(), memberOf.id, author, "member");

		const inOwned = await seedFor(author, { visibility: "org" }, owned.id);
		const inMemberOf = await seedFor(
			author,
			{ visibility: "org" },
			memberOf.id,
		);

		const page = await readPool(
			db(),
			{ userId: reader },
			{ limit: 50 },
			async () => [owned.id, memberOf.id],
		);

		expect(idsIn(page).sort()).toEqual([inMemberOf.id, inOwned.id].sort());
		expect(page.retractableIn).toEqual({
			[inOwned.id]: { org_id: owned.id, org_name: "Acme" },
		});
	});
});

/**
 * D3 is a claim about queries NOT run, which no test above observes - each
 * of them only checks what `page.retractableIn` holds, which is the same
 * whether the lazy branch ran zero extra statements or two of them that
 * happened to resolve to nothing. This proves the shortcut itself.
 */
describe("retractable_in, the laziness proof (D3)", () => {
	it("runs no statement against orgs or org_memberships for a private-only page", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		// A real org this reader owns, so ownerOrgIdsForUser would have
		// something to find if it ran at all. The point is that it must not
		// run - not that it would come back empty if it did, which a reader
		// could otherwise mistake for the proof.
		await createOrgWithOwner(db(), "Acme", owner);
		await seedFor(owner, { visibility: "private" });
		await seedFor(theirs, { visibility: "public" });

		const { sqls, db: spied } = spy(db());
		const page = await readPool(spied, { userId: owner }, { limit: 50 });

		// Sanity: this is an ordinary page with rows on it, not an empty one
		// that would make "no extra statement ran" trivially true for a
		// different reason.
		expect(idsIn(page).length).toBe(2);
		expect(page.retractableIn).toEqual({});
		expect(anyStatementTouches(sqls, "orgs")).toBe(false);
		// This half is NOT evidence of the same laziness decision the `orgs`
		// assertion above pins. It holds only because this call passes no
		// fourth argument, so `resolveOrgIds` defaults to `noOrgIds` and
		// never reads `org_memberships` at all. The production caller,
		// `listLessonsPage`, always passes `orgIdsForUser` as that resolver,
		// which reads `org_memberships` unconditionally for every page,
		// private-only ones included - the predicate's membership read was
		// never gated on whether anything turns out to be org-reached. Do
		// not move this assertion into a test that calls `listLessonsPage`
		// expecting it to still hold; it would go red for a reason that has
		// nothing to do with D3.
		expect(anyStatementTouches(sqls, "org_memberships")).toBe(false);
	});

	// The positive half, so the negative assertion above cannot pass because
	// `spy`'s Proxy or `anyStatementTouches`'s matcher is silently broken
	// and would never have caught a real statement either.
	it("runs both statements when a row is org-reached", async () => {
		const owner = (await createUser(db(), "owner@example.com", "hash", "Ona"))
			.id;
		const author = (await createUser(db(), "author@example.com", "hash", "Al"))
			.id;
		const org = await createOrgWithOwner(db(), "Acme", owner);
		await addMembership(db(), org.id, author, "member");
		await seedFor(author, { visibility: "org" }, org.id);

		const { sqls, db: spied } = spy(db());
		const page = await readPool(
			spied,
			{ userId: owner },
			{ limit: 50 },
			async () => [org.id],
		);

		expect(page.retractableIn).not.toEqual({});
		expect(anyStatementTouches(sqls, "orgs")).toBe(true);
		expect(anyStatementTouches(sqls, "org_memberships")).toBe(true);
	});
});

describe("getLessonForUser's author_name", () => {
	it("names the author of an org lesson the reader reaches through their org", async () => {
		const ada = (await createUser(db(), "ada4@example.com", "hash", "Ada")).id;
		const org = await createOrgWithOwner(db(), "Acme Three", ada);
		await addMembership(db(), org.id, mine, "member");
		const shared = await seedFor(ada, { visibility: "org" }, org.id);

		expect((await getLessonForUser(db(), mine, shared.id))?.author_name).toBe(
			"Ada",
		);
	});

	it("names nobody for a public lesson", async () => {
		const pub = await seedFor(theirs, { visibility: "public" });

		expect(
			(await getLessonForUser(db(), mine, pub.id))?.author_name,
		).toBeNull();
	});

	it("names nobody for a public lesson that carries an org_id", async () => {
		// The ablation target. Built by hand for the reason the sidecar's
		// equivalent test gives: through the writer a public row's org_id is
		// always NULL, so the org_id clause alone would exclude it and the
		// visibility clause would be untestable.
		await addMembership(db(), "org-a", mine, "member");
		const pub = await seedFor(theirs, { visibility: "public" });
		await db()
			.prepare("UPDATE lessons SET org_id = ? WHERE id = ?")
			.bind("org-a", pub.id)
			.run();

		expect(
			(await getLessonForUser(db(), mine, pub.id))?.author_name,
		).toBeNull();
	});

	it("names nobody for the reader's own private lesson", async () => {
		const own = await seedFor(mine, { visibility: "private" });

		expect(
			(await getLessonForUser(db(), mine, own.id))?.author_name,
		).toBeNull();
	});
});
