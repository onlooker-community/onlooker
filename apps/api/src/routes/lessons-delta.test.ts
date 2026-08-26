import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	BASE,
	lesson,
	mintMachine,
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

	// This test used to send onlk_ + 64 zeros, a token that was never issued -
	// so nothing was revoked, and deleting the revoked_at clause from
	// verifyMachineToken left it green. A revoked token has to be a token that
	// was real first, or the revocation is not what the 401 proves.
	it("rejects a machine token that has been revoked", async () => {
		const machine = await mintMachine("revoked@example.com");

		// It works, so the 401 below is about the revocation and nothing else.
		const before = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${machine.token}` },
		});
		expect(before.status).toBe(200);

		const revoke = await SELF.fetch(`${BASE}/api/machines/${machine.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${machine.accessToken}` },
		});
		expect(revoke.status).toBe(200);

		const after = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${machine.token}` },
		});
		expect(after.status).toBe(401);
	});

	it("rejects a machine token that was never issued", async () => {
		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer onlk_${"0".repeat(64)}` },
		});

		expect(response.status).toBe(401);
	});

	// Revoking a lost laptop must not sign the other machines out.
	it("leaves the account's other machines working", async () => {
		const lost = await mintMachine("two-machines@example.com");
		const kept = await SELF.fetch(`${BASE}/api/machines`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${lost.accessToken}`,
			},
			body: JSON.stringify({ name: "desk machine" }),
		});
		const { token: keptToken } = (await kept.json()) as { token: string };

		await SELF.fetch(`${BASE}/api/machines/${lost.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${lost.accessToken}` },
		});

		const response = await SELF.fetch(`${BASE}/lessons?since=0`, {
			headers: { Authorization: `Bearer ${keptToken}` },
		});

		expect(response.status).toBe(200);
	});

	// Removing Math.min at the clamp turns ?limit=1000000 into an unbounded read
	// of a user's entire feed into one response.
	it("clamps a limit above the ceiling", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		// 500 more feed rows for the same lesson rather than 500 more lessons: the
		// delta read joins the feed to current state, and the spec says a lesson
		// appearing twice in one window is harmless because the client upserts by
		// id. That makes this cheap, and it exercises exactly the row count the
		// clamp is about.
		const filler = Array.from({ length: 500 }, (_, at) =>
			db()
				.prepare(
					"INSERT INTO lesson_feed (seq, user_id, lesson_id, kind, at) SELECT ?, user_id, ?, 'status', ? FROM lesson_feed WHERE seq = 1",
				)
				.bind(at + 2, written.id, "2026-08-22T00:00:00.000Z"),
		);
		await db().batch(filler);

		const response = await SELF.fetch(`${BASE}/lessons?since=0&limit=1000000`, {
			headers: { Authorization: `Bearer ${machineToken}` },
		});

		const body = (await response.json()) as {
			lessons: unknown[];
			has_more: boolean;
		};
		// Exactly the ceiling, out of 501 available: "at most" would also pass
		// with a clamp set to the wrong number.
		expect(body.lessons).toHaveLength(500);
		expect(body.has_more).toBe(true);
	});
});
