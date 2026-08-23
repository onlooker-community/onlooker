import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BASE,
	lesson,
	mintMachineToken,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";

const db = () => env.DB;
let machineToken: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	machineToken = await mintMachineToken("push@example.com");
	resetLessonCounter();
});

describe("POST /lessons/:id/status", () => {
	it("records a retraction and advances the feed", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		expect(response.status).toBe(200);
		expect((await response.json()) as { seq: number }).toEqual({
			id: written.id,
			seq: 2,
		});
	});

	// The correction that split the feed from the state. A transition APPENDS;
	// it must not move the lesson's original feed row, or the sequence develops
	// a hole and every contiguity check fails on healthy data.
	it("appends to the feed rather than moving the original row", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		const rows = await db()
			.prepare("SELECT seq, kind FROM lesson_feed ORDER BY seq")
			.all<{ seq: number; kind: string }>();

		expect(rows.results).toEqual([
			{ seq: 1, kind: "create" },
			{ seq: 2, kind: "status" },
		]);
	});

	// The route's PRIMARY EFFECT, and it had no test at all until a mutation
	// found that out: neutering the UPDATE so it matched no rows left the whole
	// 176-test suite green. The response envelope and the feed rows were both
	// checked; the row the route exists to modify was not.
	//
	// The production failure that hides behind that gap is a bad one. The feed
	// advances, so every mirror is told "something changed here", pulls the
	// lesson, and receives identical content. The retraction silently does
	// nothing and the system looks healthy.
	it("actually changes the stored lesson, not just the feed", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		const row = await db()
			.prepare("SELECT status, body FROM lessons WHERE id = ?")
			.bind(written.id)
			.first<{ status: string; body: string }>();

		// Both representations, because they can disagree: `status` is the column
		// the server filters on, `body.status` is what the client mirror reads.
		expect(row?.status).toBe("retracted");
		expect(JSON.parse(row?.body ?? "{}").status).toBe("retracted");
	});

	// The parameter in this route is NOT the last segment - "status" is. Handlers
	// used to re-derive the id from the path themselves, each with a rule fitted
	// to its own route's shape, so reading the wrong segment was a live hazard
	// with no type or test standing in the way. The router now hands the id over
	// as a captured parameter (onlooker-r5v).
	//
	// Two lessons, not one, and the assertion is on the one NOT named in the
	// path. With a single lesson a handler that ignored its parameter entirely
	// and retracted whatever it found would still pass.
	it("transitions the lesson named in the path, not a neighbor", async () => {
		const target = lesson();
		const bystander = lesson();
		await push(machineToken, [target, bystander]);

		const response = await SELF.fetch(`${BASE}/lessons/${target.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		// A mis-read parameter shows up here first: "status" is not a lesson id,
		// so the lookup misses and the route 404s without ever saying why.
		expect(response.status).toBe(200);

		const rows = await db()
			.prepare("SELECT id, status FROM lessons ORDER BY id")
			.all<{ id: string; status: string }>();

		expect(
			Object.fromEntries(rows.results.map((row) => [row.id, row.status])),
		).toEqual({ [target.id]: "retracted", [bystander.id]: "active" });
	});

	it("records superseded_by in the stored lesson", async () => {
		const original = lesson();
		const replacement = lesson();
		await push(machineToken, [original, replacement]);

		const response = await SELF.fetch(`${BASE}/lessons/${original.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({
				status: "superseded",
				superseded_by: replacement.id,
			}),
		});

		expect(response.status).toBe(200);

		const row = await db()
			.prepare("SELECT status, body FROM lessons WHERE id = ?")
			.bind(original.id)
			.first<{ status: string; body: string }>();

		expect(row?.status).toBe("superseded");
		expect(JSON.parse(row?.body ?? "{}").superseded_by).toBe(replacement.id);
	});

	it("rejects superseded_by on a status that is not superseded", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({
				status: "retracted",
				superseded_by: "01KZ45MKAM734ZS7JK24D2DK99",
			}),
		});

		expect(response.status).toBe(400);
	});

	it("404s for a lesson id that does not exist", async () => {
		const response = await SELF.fetch(
			`${BASE}/lessons/01KZ45MKAM734ZS7JK24D2DK98/status`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${machineToken}`,
				},
				body: JSON.stringify({ status: "retracted", superseded_by: null }),
			},
		);

		expect(response.status).toBe(404);
	});

	it("rejects a status the contract does not define", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "expired", superseded_by: null }),
		});

		// There is deliberately no "expired" state: expiry is structural, and a
		// stored expired status would need a job sweeping the pool to set it.
		expect(response.status).toBe(400);
	});

	it("requires superseded_by when the status is superseded", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const response = await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "superseded", superseded_by: null }),
		});

		expect(response.status).toBe(400);
	});

	it("will not transition another user's lesson", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const otherToken = await mintMachineToken("other@example.com");
		const response = await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${otherToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		expect(response.status).toBe(404);
	});
});
