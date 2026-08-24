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

	it("clamps limit to the maximum rather than failing", async () => {
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
		expect((await response.json()) as { id: string }).toMatchObject({
			id: written.id,
		});
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
