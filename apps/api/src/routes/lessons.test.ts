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

describe("POST /lessons", () => {
	it("rejects a request with no machine token", async () => {
		const response = await SELF.fetch(`${BASE}/lessons`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lessons: [lesson()] }),
		});

		expect(response.status).toBe(401);
	});

	it("stores a valid lesson and returns its seq", async () => {
		const response = await push(machineToken, [lesson()]);

		expect(response.status).toBe(200);
		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; seq: number }>;
		};
		expect(results[0].outcome).toBe("created");
		expect(results[0].seq).toBe(1);
	});

	// A re-push is the hot path, not a rare one: a mirror re-encounters lessons
	// it already holds constantly.
	it("treats an identical re-push as a no-op", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const again = await push(machineToken, [written]);

		const { results } = (await again.json()) as {
			results: Array<{ outcome: string }>;
		};
		expect(results[0].outcome).toBe("noop");

		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed")
			.first<{ n: number }>();
		expect(feed?.n).toBe(1);
	});

	// The reason canonicalize exists. Comparing raw strings would make this a
	// 409 and break every mirror.
	it("treats a re-push with reordered keys as a no-op", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const reordered = Object.fromEntries(Object.entries(written).reverse());
		const again = await push(machineToken, [reordered]);

		const { results } = (await again.json()) as {
			results: Array<{ outcome: string }>;
		};
		expect(results[0].outcome).toBe("noop");
	});

	it("rejects a re-push whose content differs", async () => {
		const written = lesson();
		await push(machineToken, [written]);
		const changed = await push(machineToken, [
			{ ...written, claim: "Something else entirely" },
		]);

		const { results } = (await changed.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("conflict");
		expect(results[0].error).toContain("claim");
	});

	it("rejects org and public with a message naming the tier", async () => {
		const response = await push(machineToken, [
			lesson({ visibility: "public" }),
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("invalid");
		expect(results[0].error).toMatch(/not open/i);
	});

	it("rejects a lesson that breaks a cross-field rule", async () => {
		const response = await push(machineToken, [
			lesson({
				consensus: {
					judges: 1,
					agreed: 9,
					decided_at: "2026-08-22T00:00:00.000Z",
				},
			}),
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("invalid");
		expect(results[0].error).toContain("consensus");
	});

	// One bad lesson must not reject nineteen good ones, or the client re-pushes
	// all twenty and keeps doing it.
	it("reports per item, storing the valid ones", async () => {
		const good = lesson();
		const bad = lesson({ schema_version: 99 });
		const alsoGood = lesson();

		const response = await push(machineToken, [good, bad, alsoGood]);
		const { results } = (await response.json()) as {
			results: Array<{ outcome: string }>;
		};

		expect(results.map((r) => r.outcome)).toEqual([
			"created",
			"invalid",
			"created",
		]);

		const stored = await db()
			.prepare("SELECT COUNT(*) AS n FROM lessons")
			.first<{ n: number }>();
		expect(stored?.n).toBe(2);
	});

	// Both of the route's remaining guards, which had no tests at all when this
	// task first shipped. A rule in the code with nothing exercising it is the
	// defect this plan keeps finding; these two are no different for being small.
	it("rejects a batch over the size cap", async () => {
		// The cap is checked on the array length BEFORE any lesson is parsed, so
		// these do not need to be valid lessons - which is also what the test
		// proves. Remove the cap and this returns 200 with 101 per-item results.
		const oversized = Array.from({ length: 101 }, () => ({}));

		const response = await push(machineToken, oversized);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: string; code?: string };
		expect(JSON.stringify(body)).toMatch(/batch_too_large|At most 100/);
	});

	it("rejects superseded_by on a lesson that is not superseded", async () => {
		const response = await push(machineToken, [
			lesson({ superseded_by: "01KZ45MKAM734ZS7JK24D2DK99" }),
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("invalid");
		expect(results[0].error).toContain("superseded_by");
	});

	// The 409 must not become an existence oracle over other users' lesson ids.
	it("does not reveal that an id belongs to someone else", async () => {
		const written = lesson();
		await push(machineToken, [written]);

		const otherToken = await mintMachineToken("other@example.com");
		const response = await push(otherToken, [
			{ ...written, claim: "A completely different claim" },
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("conflict");
		// No field-level diff, because that would confirm what the other user wrote.
		expect(results[0].error).not.toContain("claim");
	});
});
