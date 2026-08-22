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
