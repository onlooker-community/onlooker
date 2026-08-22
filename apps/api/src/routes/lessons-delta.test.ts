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

describe("GET /lessons", () => {
	it("returns everything from a zero cursor", async () => {
		await push(machineToken, [lesson(), lesson(), lesson()]);

		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});

		const body = (await response.json()) as {
			lessons: unknown[];
			cursor: number;
			has_more: boolean;
		};
		expect(body.lessons).toHaveLength(3);
		expect(body.cursor).toBe(3);
		expect(body.has_more).toBe(false);
	});

	it("returns only what is after the cursor", async () => {
		await push(machineToken, [lesson(), lesson(), lesson()]);

		const response = await SELF.fetch(`${BASE}/lessons?since=2`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});

		const body = (await response.json()) as {
			lessons: unknown[];
			cursor: number;
		};
		expect(body.lessons).toHaveLength(1);
		expect(body.cursor).toBe(3);
	});

	it("reports when more remains", async () => {
		await push(machineToken, [lesson(), lesson(), lesson()]);

		const response = await SELF.fetch(`${BASE}/lessons?since=0&limit=2`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});

		const body = (await response.json()) as {
			cursor: number;
			has_more: boolean;
		};
		expect(body.has_more).toBe(true);
		expect(body.cursor).toBe(2);
	});

	// THE security boundary. If this fails, the pool leaks private lessons.
	it("never returns another user's lessons", async () => {
		await push(machineToken, [lesson(), lesson()]);

		const otherToken = await mintMachineToken("other@example.com");
		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${otherToken}` },
		});

		const body = (await response.json()) as { lessons: unknown[] };
		expect(body.lessons).toEqual([]);
	});

	it("delivers a contiguous sequence across creates and transitions", async () => {
		const written = lesson();
		await push(machineToken, [written, lesson()]);
		await SELF.fetch(`${BASE}/lessons/${written.id}/status`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${machineToken}`,
			},
			body: JSON.stringify({ status: "retracted", superseded_by: null }),
		});

		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});

		const body = (await response.json()) as {
			lessons: Array<{ seq: number }>;
		};
		expect(body.lessons.map((l) => l.seq)).toEqual([1, 2, 3]);
	});

	it("rejects a machine token that has been revoked", async () => {
		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: "Bearer onlk_" + "0".repeat(64) },
		});

		expect(response.status).toBe(401);
	});
});
