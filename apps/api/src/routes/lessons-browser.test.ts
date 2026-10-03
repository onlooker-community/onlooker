import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const minted = await mintMachine("browser@example.com");
	accessToken = minted.accessToken;
	machineToken = minted.token;
	resetLessonCounter();
});

const browse = (path: string, init: RequestInit = {}) =>
	SELF.fetch(`${BASE}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});

describe("GET /api/lessons", () => {
	it("rejects a request with no session", async () => {
		const response = await SELF.fetch(`${BASE}/api/lessons`);
		expect(response.status).toBe(401);
	});

	// The credential split, asserted. A machine token opens the sync routes and
	// must not open the browsing ones.
	it("rejects a machine token", async () => {
		const response = await SELF.fetch(`${BASE}/api/lessons`, {
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

		const response = await SELF.fetch(`${BASE}/api/lessons/${written.id}`, {
			headers: { Authorization: `Bearer ${stranger.accessToken}` },
		});

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

		const response = await SELF.fetch(
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
			await SELF.fetch(`${BASE}/lessons?since=1`, {
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
 * It has to be written PAST the push gate rather than through it: while the
 * push tier is closed, routes/lessons.ts rejects every non-private visibility,
 * so the row this read is meant to widen onto cannot be created through the
 * API at all. Pushing it private and promoting the column directly produces
 * exactly the state that opening the gate will produce.
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
