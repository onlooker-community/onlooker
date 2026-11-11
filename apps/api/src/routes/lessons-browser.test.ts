import { env, exports } from "cloudflare:workers";
import type { TLesson } from "@onlooker-community/lesson-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createLessonsWithFeed } from "../db/lessons.js";
import { addMembership, createOrgWithOwner } from "../db/orgs.js";
import { createUser, getUserByEmail } from "../db/queries.js";
import { putSessionSummaries } from "../db/session-summaries.js";
import {
	BASE,
	lesson,
	mintMachine,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";

const db = () => env.DB;
let accessToken: string;
let machineToken: string;
let machineId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM session_projects").run();
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM org_memberships").run();
	await db().prepare("DELETE FROM orgs").run();
	await db().prepare("DELETE FROM users").run();
	const minted = await mintMachine("browser@example.com");
	accessToken = minted.accessToken;
	machineToken = minted.token;
	machineId = minted.id;
	resetLessonCounter();
});

const browse = (path: string, init: RequestInit = {}) =>
	exports.default.fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});

describe("GET /api/lessons", () => {
	it("rejects a request with no session", async () => {
		const response = await exports.default.fetch(`${BASE}/api/lessons`);
		expect(response.status).toBe(401);
	});

	// The credential split, asserted. A machine token opens the sync routes and
	// must not open the browsing ones.
	it("rejects a machine token", async () => {
		const response = await exports.default.fetch(`${BASE}/api/lessons`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});
		expect(response.status).toBe(401);
	});

	it("returns an empty pool as an empty list, not a 404", async () => {
		const response = await browse("/api/lessons");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			lessons: [],
			cursor: null,
			has_more: false,
			owned_ids: [],
			authors: {},
			former_authors: [],
			retractable_in: {},
		});
	});

	it("returns pushed lessons newest first", async () => {
		await push(machineToken, [
			lesson({ promoted_at: "2026-08-01T00:00:00.000Z" }),
			lesson({ promoted_at: "2026-08-03T00:00:00.000Z" }),
			lesson({ promoted_at: "2026-08-02T00:00:00.000Z" }),
		]);

		const body = (await (await browse("/api/lessons")).json()) as {
			lessons: Array<{ promoted_at: string }>;
		};

		expect(body.lessons.map((l) => l.promoted_at)).toEqual([
			"2026-08-03T00:00:00.000Z",
			"2026-08-02T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
		]);
	});

	it("rejects a cursor it did not mint", async () => {
		const response = await browse("/api/lessons?cursor=not-a-real-cursor");
		expect(response.status).toBe(400);
		expect(
			(await response.json()) as { error: { code: string } },
		).toMatchObject({
			error: { code: "invalid_cursor" },
		});
	});

	it("rejects a status nobody could hold", async () => {
		const response = await browse("/api/lessons?status=banana");
		expect(response.status).toBe(400);
	});

	// Against an empty pool this only proves the request does not 400 - it
	// cannot tell a clamped limit from an unclamped one, since either way
	// there is nothing to return. The clamp itself is proven at the db layer,
	// in lessons-browser.test.ts, where seeding enough rows to matter is
	// cheap.
	it("does not reject a limit above the maximum", async () => {
		const response = await browse("/api/lessons?limit=99999");
		expect(response.status).toBe(200);
	});
});

describe("GET /api/lessons/:id", () => {
	it("returns one lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await browse(`/api/lessons/${written.id}`);

		expect(response.status).toBe(200);
		// Enveloped: the document under `lesson`, with `own` beside it. See
		// "ownership, so the browser knows what it may act on" below.
		expect((await response.json()) as { lesson: { id: string } }).toMatchObject(
			{ lesson: { id: written.id } },
		);
	});

	it("404s an id nobody holds", async () => {
		const response = await browse("/api/lessons/01NOPE00000000000000000000");
		expect(response.status).toBe(404);
	});

	// 404 rather than 403, so the response cannot confirm the id exists.
	it("404s another account's lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const stranger = await mintMachine("stranger@example.com");

		const response = await exports.default.fetch(
			`${BASE}/api/lessons/${written.id}`,
			{
				headers: { Authorization: `Bearer ${stranger.accessToken}` },
			},
		);

		expect(response.status).toBe(404);
	});
});

describe("PATCH /api/lessons/:id/status", () => {
	const patch = (id: string, status: string) =>
		browse(`/api/lessons/${id}/status`, {
			method: "PATCH",
			body: JSON.stringify({ status }),
		});

	it("retracts a lesson and advances the feed", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await patch(written.id, "retracted");

		expect(response.status).toBe(200);
		expect((await response.json()) as { seq: number }).toEqual({
			id: written.id,
			seq: 2,
		});
	});

	it("un-retracts a lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		await patch(written.id, "retracted");

		expect((await patch(written.id, "active")).status).toBe(200);
	});

	// The browser cannot assert a verdict the tribunal never reached. Enforced
	// here, not by which buttons the UI renders.
	it("refuses refuted and superseded", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		for (const status of ["refuted", "superseded"]) {
			const response = await patch(written.id, status);
			expect(response.status).toBe(400);
			expect(
				(await response.json()) as { error: { code: string } },
			).toMatchObject({
				error: { code: "status_not_allowed" },
			});
		}
	});

	it("404s another account's lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const stranger = await mintMachine("stranger@example.com");

		const response = await exports.default.fetch(
			`${BASE}/api/lessons/${written.id}/status`,
			{
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${stranger.accessToken}`,
				},
				body: JSON.stringify({ status: "retracted" }),
			},
		);

		expect(response.status).toBe(404);
	});

	// A retraction made in the browser must reach every mirror on its next
	// delta pull - that is why it goes through transitionLesson rather than
	// writing the row directly.
	it("is visible to the machine delta read", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		await patch(written.id, "retracted");

		const delta = (await (
			await exports.default.fetch(`${BASE}/lessons?since=1`, {
				headers: { Authorization: `Bearer ${machineToken}` },
			})
		).json()) as { lessons: Array<{ lesson: { status: string } }> };

		// The delta route wraps each entry as { seq, lesson }, so the status
		// lives one level down from what a flat shape would suggest.
		expect(delta.lessons.at(-1)?.lesson.status).toBe("retracted");
	});
});

/**
 * A public lesson belonging to somebody else.
 *
 * Written PAST the push gate rather than through it. The gate opened for
 * `public` on 2026-10-03, so this COULD now go through the route - but only
 * with a unanimous jury, and these tests are about the read path's ownership
 * boundary rather than the admission bar. Promoting the column directly keeps
 * the subject under this file's control and keeps these tests from failing
 * for a reason that has nothing to do with what they assert.
 *
 * The body's own `visibility` is moved with the column. The predicate only
 * reads the column, so the test would pass either way - but the response
 * returns `body`, and a document that calls itself private while the pool
 * serves it to strangers is a confusing thing to hand an assertion.
 */
async function seedForeignPublicLesson(email = "stranger@example.com") {
	const stranger = await mintMachine(email);
	const written = lesson();
	await push(stranger.token, [written]);
	await db()
		.prepare(
			"UPDATE lessons SET visibility = 'public'," +
				" body = json_set(body, '$.visibility', 'public') WHERE id = ?",
		)
		.bind(written.id)
		.run();
	return { stranger, written };
}

/**
 * The read widening that landed with the shared lesson tiers, observed at the
 * route rather than at the db layer.
 *
 * db/pool.test.ts already proves the predicate itself. What none of it proves
 * is that the widening survives the trip through the route - and the routes
 * were never opened by the six tasks that built this, so until now nothing
 * above db/ observed the change at all. These are guard tests: they pass
 * today, and each was confirmed to fail by ablating the behavior it guards
 * (re-narrowing the pool predicate to the owner, and dropping owned_ids).
 */
describe("the public tier widening, at the route", () => {
	it("lists another account's public lesson", async () => {
		const { written } = await seedForeignPublicLesson();

		const body = (await (await browse("/api/lessons")).json()) as {
			lessons: Array<{ id: string }>;
		};

		expect(body.lessons.map((entry) => entry.id)).toEqual([written.id]);
	});

	it("returns another account's public lesson by id", async () => {
		const { written } = await seedForeignPublicLesson();

		const response = await browse(`/api/lessons/${written.id}`);

		expect(response.status).toBe(200);
	});

	// The asymmetry this bead exists for. The READ widened and the WRITE did
	// not: transitionLesson's WHERE is still `id = ? AND user_id = ?`, so the
	// pool hands a stranger's lesson to a browser that cannot act on it. The
	// 404 is correct - a stranger may not retract what is not theirs - which
	// is precisely why the UI must not offer the control.
	it("refuses to retract another account's public lesson", async () => {
		const { written } = await seedForeignPublicLesson();

		const response = await browse(`/api/lessons/${written.id}/status`, {
			method: "PATCH",
			body: JSON.stringify({ status: "retracted" }),
		});

		expect(response.status).toBe(404);
	});
});

/**
 * What the browser needs in order not to offer that losing control.
 *
 * The read returns `SELECT body`, and a lesson body carries no user_id - by
 * design, since it is the published document and another account's owner is
 * not the reader's business. So ownership cannot be derived client-side at
 * all, and the server has to say it. It is carried BESIDE the documents
 * rather than inside them: a body is @onlooker-community/lesson-contract's
 * shape and nothing server-computed belongs in it.
 */
describe("ownership, so the browser knows what it may act on", () => {
	it("names the listed lessons the caller owns", async () => {
		const mine = lesson();
		await push(machineToken, [mine]);
		const { written: theirs } = await seedForeignPublicLesson();

		const body = (await (await browse("/api/lessons")).json()) as {
			lessons: Array<{ id: string }>;
			owned_ids: string[];
		};

		// Both are listed; only one is the caller's.
		expect(body.lessons.map((entry) => entry.id).sort()).toEqual(
			[mine.id, theirs.id].sort(),
		);
		expect(body.owned_ids).toEqual([mine.id]);
	});

	it("names no owner when the page holds only other people's lessons", async () => {
		await seedForeignPublicLesson();

		const body = (await (await browse("/api/lessons")).json()) as {
			owned_ids: string[];
		};

		// Present and empty, not absent: a client that reads `owned_ids` to
		// decide what to render must not have to distinguish "none" from
		// "this server does not say".
		expect(body.owned_ids).toEqual([]);
	});

	it("says the caller owns the lesson it fetched by id", async () => {
		const mine = lesson();
		await push(machineToken, [mine]);

		const body = (await (await browse(`/api/lessons/${mine.id}`)).json()) as {
			lesson: { id: string };
			own: boolean;
		};

		expect(body).toMatchObject({ lesson: { id: mine.id }, own: true });
	});

	it("says the caller does not own another account's public lesson", async () => {
		const { written } = await seedForeignPublicLesson();

		const body = (await (
			await browse(`/api/lessons/${written.id}`)
		).json()) as { lesson: { id: string }; own: boolean };

		expect(body).toMatchObject({ lesson: { id: written.id }, own: false });
	});
});

/**
 * db/pool.test.ts already proves readPool computes the sidecar. What it
 * cannot prove is that the sidecar survives the trip through the route - the
 * same gap the ownership tests above close for owned_ids.
 */
describe("org attribution, at the route", () => {
	it("names org authors in the browse response", async () => {
		// Two accounts in one org: the milestone's done-when, at the route.
		const reader = await getUserByEmail(db(), "browser@example.com");
		const org = await createOrgWithOwner(
			db(),
			"Acme",
			(reader as { id: string }).id,
		);
		const author = (await createUser(db(), "author@example.com", "hash", "Bob"))
			.id;

		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), author, [shared], org.id);

		const body = (await (await browse("/api/lessons")).json()) as {
			lessons: Array<{ id: string }>;
			authors: Record<string, string>;
		};

		expect(body.authors[shared.id]).toBe("Bob");
	});
});

/**
 * db/pool.test.ts already proves readPool computes retractableIn. What it
 * cannot prove is that the sidecar survives the trip through the route - the
 * same gap "org attribution, at the route" closes for authors.
 */
describe("retractable_in, at the route", () => {
	it("names the org for an owner reading a teammate's org lesson", async () => {
		const reader = await getUserByEmail(db(), "browser@example.com");
		const org = await createOrgWithOwner(
			db(),
			"Acme",
			(reader as { id: string }).id,
		);
		const author = (await createUser(db(), "author@example.com", "hash", "Bob"))
			.id;
		await addMembership(db(), org.id, author, "member");

		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), author, [shared], org.id);

		const body = (await (await browse("/api/lessons")).json()) as {
			retractable_in: Record<string, { org_id: string; org_name: string }>;
		};

		expect(body.retractable_in).toEqual({
			[shared.id]: { org_id: org.id, org_name: "Acme" },
		});
	});

	// The by-id twin of the browse-route test above. Nothing joins
	// getLessonForUser's db-level coverage of `retractable_in` to the
	// `GET /api/lessons/:id` route it travels through - a hardcoded `null`
	// at lessons-browser.ts:120 would pass every other test in this file
	// and in db/pool.test.ts alike. This is the design's exact warning
	// about what shipped broken on the previous branch, closed here for the
	// single-lesson route the way the browse route was already closed
	// above.
	it("names the org for an owner reading a teammate's org lesson, on the single-lesson route", async () => {
		const reader = await getUserByEmail(db(), "browser@example.com");
		const org = await createOrgWithOwner(
			db(),
			"Acme",
			(reader as { id: string }).id,
		);
		const author = (await createUser(db(), "author@example.com", "hash", "Bob"))
			.id;
		await addMembership(db(), org.id, author, "member");

		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), author, [shared], org.id);

		const body = (await (await browse(`/api/lessons/${shared.id}`)).json()) as {
			retractable_in: { org_id: string; org_name: string } | null;
		};

		expect(body.retractable_in).toEqual({ org_id: org.id, org_name: "Acme" });
	});
});

/**
 * db/pool.test.ts already proves readPool and getLessonForUser compute the
 * anonymized-author facts. What it cannot prove is that they survive the trip
 * through the route - the same gap "org attribution, at the route" and
 * "retractable_in, at the route" close for their own sidecars, and the one
 * ONL-141 shipped untested and had to fix after review.
 */
describe("former_authors and former_author, at the route", () => {
	it("serializes former_authors and former_author", async () => {
		// Seed an org lesson by somebody else, then anonymize them by hand -
		// this test is about the serialization, not about deleteUser, so it
		// sets the column directly rather than depending on Task 3.
		const reader = await getUserByEmail(db(), "browser@example.com");
		const org = await createOrgWithOwner(
			db(),
			"Acme",
			(reader as { id: string }).id,
		);
		const author = (await createUser(db(), "author@example.com", "hash", "Bob"))
			.id;

		const shared = lesson({ visibility: "org" }) as TLesson;
		await createLessonsWithFeed(db(), author, [shared], org.id);
		await db()
			.prepare("UPDATE users SET name = NULL, anonymized_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), author)
			.run();

		const page = (await (await browse("/api/lessons")).json()) as {
			former_authors: string[];
			authors: Record<string, string>;
		};
		expect(page.former_authors).toContain(shared.id);
		expect(page.authors[shared.id]).toBeUndefined();

		const one = (await (await browse(`/api/lessons/${shared.id}`)).json()) as {
			former_author: boolean;
		};
		expect(one).toMatchObject({ former_author: true });
	});
});

/**
 * GET /api/lessons?project= narrows the pool, and the pool mixes accounts.
 *
 * So most of what is asserted here is what must NOT come back. A key on
 * someone else's lesson counts only where the caller holds it as `remote`:
 * that names one repository for everyone, while a `root` key hashes a local
 * path, and matching on it would tell the caller that a stranger has a path
 * which hashes the same.
 */
describe("GET /api/lessons?project=", () => {
	const KEY = "aaaaaaaaaaaa";
	const OTHER_KEY = "bbbbbbbbbbbb";

	let held = 0;

	const readerId = async () =>
		((await getUserByEmail(db(), "browser@example.com")) as { id: string }).id;

	/** The reader reports a session that touched `key` on this basis. */
	async function hold(key: string, basis: "remote" | "root") {
		held += 1;
		await putSessionSummaries(db(), await readerId(), machineId, [
			{
				session_id: `held-${held}`,
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
				event_count: 1,
				counts_by_prefix: {},
				counts_by_project: { [key]: { basis, event_count: 1 } },
				plugins: [],
				prompts: 0,
				compactions: 0,
			},
		]);
	}

	/** A lesson on `key`, written past the push gate like the seeds above. */
	async function seedOn(
		owner: string,
		key: string,
		overrides: Record<string, unknown> = {},
		orgId: string | null = null,
	): Promise<TLesson> {
		const base = lesson();
		const written = {
			...base,
			evidence: { ...base.evidence, project_key: key },
			...overrides,
		} as TLesson;
		await createLessonsWithFeed(db(), owner, [written], orgId);
		return written;
	}

	const stranger = async (email = "stranger@example.com") =>
		(await createUser(db(), email, "hash", "Bob")).id;

	const idsAt = async (path: string) =>
		(
			(await (await browse(path)).json()) as { lessons: Array<{ id: string }> }
		).lessons.map((entry) => entry.id);

	it("finds the caller's own lesson by key", async () => {
		const mine = await seedOn(await readerId(), KEY);
		await seedOn(await readerId(), OTHER_KEY);

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([mine.id]);
	});

	it("finds another account's public lesson when the caller holds the key as remote", async () => {
		const theirs = await seedOn(await stranger(), KEY, {
			visibility: "public",
		});
		await hold(KEY, "remote");

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([theirs.id]);
	});

	it("does not match another account's lesson on a key the caller holds only as root", async () => {
		await seedOn(await stranger(), KEY, { visibility: "public" });
		await hold(KEY, "root");

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([]);
	});

	it("does not match another account's lesson on a key the caller doesn't hold", async () => {
		await seedOn(await stranger(), KEY, { visibility: "public" });
		await hold(OTHER_KEY, "remote");

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([]);
	});

	// A key held by somebody else says nothing about the caller. The subquery
	// is scoped to the caller's own session rows.
	it("does not match on a key only another account holds as remote", async () => {
		const other = await stranger();
		await seedOn(other, KEY, { visibility: "public" });
		const otherMachine = await mintMachine("holder@example.com");
		const holder = (await getUserByEmail(db(), "holder@example.com")) as {
			id: string;
		};
		await putSessionSummaries(db(), holder.id, otherMachine.id, [
			{
				session_id: "theirs-1",
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
				event_count: 1,
				counts_by_prefix: {},
				counts_by_project: { [KEY]: { basis: "remote", event_count: 1 } },
				plugins: [],
				prompts: 0,
				compactions: 0,
			},
		]);

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([]);
	});

	it("does not reveal another account's private lesson", async () => {
		await seedOn(await stranger(), KEY, { visibility: "private" });
		await hold(KEY, "remote");

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([]);
	});

	it("keeps a retracted lesson of another account hidden", async () => {
		await seedOn(await stranger(), KEY, {
			visibility: "public",
			status: "retracted",
		});
		await hold(KEY, "remote");

		expect(await idsAt(`/api/lessons?project=${KEY}`)).toEqual([]);
	});

	it("finds an org-mate's org lesson on a shared remote key, and not on a root one", async () => {
		const org = await createOrgWithOwner(db(), "Acme", await readerId());
		const author = await stranger("author@example.com");
		await addMembership(db(), org.id, author, "member");
		const onRemote = await seedOn(author, KEY, { visibility: "org" }, org.id);
		await seedOn(author, OTHER_KEY, { visibility: "org" }, org.id);
		await hold(KEY, "remote");
		await hold(OTHER_KEY, "root");

		expect(
			await idsAt(`/api/lessons?project=${KEY}&project=${OTHER_KEY}`),
		).toEqual([onRemote.id]);
	});

	it("matches any of several keys", async () => {
		const a = await seedOn(await readerId(), KEY);
		const b = await seedOn(await readerId(), OTHER_KEY);
		await seedOn(await readerId(), "cccccccccccc");

		expect(
			(await idsAt(`/api/lessons?project=${KEY}&project=${OTHER_KEY}`)).sort(),
		).toEqual([a.id, b.id].sort());
	});

	it("combines with a status filter", async () => {
		await seedOn(await readerId(), KEY);
		const refuted = await seedOn(await readerId(), KEY, {
			status: "refuted",
		});
		await seedOn(await readerId(), OTHER_KEY, { status: "refuted" });

		expect(await idsAt(`/api/lessons?project=${KEY}&status=refuted`)).toEqual([
			refuted.id,
		]);
	});

	it("pages across a filter, every match once", async () => {
		const owner = await readerId();
		const written: string[] = [];
		for (let day = 1; day <= 5; day += 1) {
			written.push(
				(
					await seedOn(owner, KEY, {
						promoted_at: `2026-08-0${day}T00:00:00.000Z`,
					})
				).id,
			);
		}
		await seedOn(owner, OTHER_KEY);

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let pages = 0; pages < 10; pages += 1) {
			const path: string = `/api/lessons?project=${KEY}&limit=2${
				cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
			}`;
			const body = (await (await browse(path)).json()) as {
				lessons: Array<{ id: string }>;
				cursor: string | null;
				has_more: boolean;
			};
			seen.push(...body.lessons.map((entry) => entry.id));
			if (!body.has_more) break;
			cursor = body.cursor;
		}

		expect(seen.sort()).toEqual(written.sort());
	});

	// 38, not the 39 it shipped with: the stack filter took one bind (ONL-14).
	it("refuses more than 38 values", async () => {
		const keys = (count: number) =>
			Array.from(
				{ length: count },
				(_, i) => `project=${i.toString(16).padStart(12, "0")}`,
			).join("&");

		const tooMany = await browse(`/api/lessons?${keys(39)}`);
		expect(tooMany.status).toBe(400);
		expect(await tooMany.json()).toMatchObject({
			error: { code: "invalid_project" },
		});
		expect((await browse(`/api/lessons?${keys(38)}`)).status).toBe(200);
	});

	// 52 binds for the visibility predicate at 50 orgs, 4 statuses, 38 keys and
	// the two user ids, the stack filter's one JSON array, a cursor's two, and
	// the LIMIT: exactly D1's 100.
	it("holds at the worst case", async () => {
		const owner = await readerId();
		for (let i = 0; i < 50; i += 1) {
			await createOrgWithOwner(db(), `Org ${i}`, owner);
		}
		await seedOn(owner, KEY, { promoted_at: "2026-08-01T00:00:00.000Z" });
		await seedOn(owner, KEY, { promoted_at: "2026-08-02T00:00:00.000Z" });
		const first = (await (
			await browse(`/api/lessons?project=${KEY}&limit=1`)
		).json()) as { cursor: string };

		const keys = [KEY].concat(
			Array.from({ length: 37 }, (_, i) =>
				(i + 1).toString(16).padStart(12, "0"),
			),
		);
		// seedOn's lessons carry lesson()'s stack, "vite", so it is among them.
		const stacks = ["vite"].concat(
			Array.from({ length: 19 }, (_, i) => `stack-${i}`),
		);
		const query = [
			...keys.map((key) => `project=${key}`),
			...stacks.map((stack) => `stack=${stack}`),
			...["active", "refuted", "superseded", "retracted"].map(
				(status) => `status=${status}`,
			),
			`cursor=${encodeURIComponent(first.cursor)}`,
			"limit=1",
		].join("&");

		const response = await browse(`/api/lessons?${query}`);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { lessons: unknown[] }).lessons,
		).toHaveLength(1);
	});

	// The bind budget assumes at most four statuses. Repeating one must not
	// spend it: the read would pass D1's 100 and answer 500.
	it("holds when a status is repeated", async () => {
		await seedOn(await readerId(), KEY);
		const keys = Array.from(
			{ length: 38 },
			(_, i) => `project=${i.toString(16).padStart(12, "0")}`,
		).join("&");
		const statuses = Array.from({ length: 60 }, () => "status=active").join(
			"&",
		);

		const response = await browse(`/api/lessons?${keys}&${statuses}`);

		expect(response.status).toBe(200);
	});

	it("refuses a malformed value", async () => {
		for (const value of ["nope", "AAAAAAAAAAAA", "m1:aaaaaaaaaaaa"]) {
			const response = await browse(`/api/lessons?project=${value}`);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: "invalid_project" },
			});
		}
	});

	it("leaves the read alone without a filter", async () => {
		const unkeyed = await seedOn(await readerId(), KEY);
		await db()
			.prepare("UPDATE lessons SET project_key = NULL WHERE id = ?")
			.bind(unkeyed.id)
			.run();

		expect(await idsAt("/api/lessons")).toEqual([unkeyed.id]);
	});
});

describe("GET /api/lessons?stack=", () => {
	const readerId = async () =>
		((await getUserByEmail(db(), "browser@example.com")) as { id: string }).id;

	/** A lesson whose only stack entries are these. */
	async function seedWith(...stack: string[]): Promise<TLesson> {
		const base = lesson();
		const written = {
			...base,
			applies_to: { ...base.applies_to, stack },
		} as TLesson;
		await createLessonsWithFeed(db(), await readerId(), [written]);
		return written;
	}

	const idsAt = async (path: string) =>
		(
			(await (await browse(path)).json()) as { lessons: Array<{ id: string }> }
		).lessons.map((entry) => entry.id);

	it("narrows the read to lessons naming the stack", async () => {
		const vite = await seedWith("vite", "react");
		await seedWith("webpack");

		expect(await idsAt("/api/lessons?stack=vite")).toEqual([vite.id]);
	});

	// The bind budget does not depend on this - the values are one JSON
	// array - but a repeat would still grow that array for nothing.
	it("treats a repeated value as one", async () => {
		const vite = await seedWith("vite");

		expect(await idsAt("/api/lessons?stack=vite&stack=vite")).toEqual([
			vite.id,
		]);
	});

	it("refuses more than 20 values", async () => {
		const stacks = (count: number) =>
			Array.from({ length: count }, (_, i) => `stack=s${i}`).join("&");

		const tooMany = await browse(`/api/lessons?${stacks(21)}`);
		expect(tooMany.status).toBe(400);
		expect(await tooMany.json()).toMatchObject({
			error: { code: "invalid_stack" },
		});
		expect((await browse(`/api/lessons?${stacks(20)}`)).status).toBe(200);
	});

	it("refuses an empty value or one over 100 characters", async () => {
		for (const value of ["", "x".repeat(101)]) {
			const response = await browse(`/api/lessons?stack=${value}`);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: "invalid_stack" },
			});
		}
		expect((await browse(`/api/lessons?stack=${"x".repeat(100)}`)).status).toBe(
			200,
		);
	});

	// json_each takes the array as text: a value that is itself JSON syntax
	// must still be matched as a string, not parsed into the query.
	it("matches a value that looks like JSON as the string it is", async () => {
		const odd = await seedWith('a"],["b');

		expect(
			await idsAt(`/api/lessons?stack=${encodeURIComponent('a"],["b')}`),
		).toEqual([odd.id]);
	});
});
