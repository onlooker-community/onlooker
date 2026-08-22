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
		expect(results[0].error).toMatch(/immutable/i);
		// This one really is a content rewrite, so it must NOT be described as a
		// stale copy the pusher can fix by pulling.
		expect(results[0].error).not.toMatch(/pull before you push/i);
	});

	// The reachable case where the old message asserted something false. A
	// mirror re-pushes a copy it holds at a stale status - AFTER someone used
	// the status route - and was told "content is immutable; use the status
	// route", naming the one field it is allowed to change and pointing at the
	// route that caused the difference. Its actual problem is "pull first".
	it("tells a mirror with a stale lifecycle to pull, not that content is immutable", async () => {
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

		const stale = await push(machineToken, [written]);

		const { results } = (await stale.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("conflict");
		expect(results[0].error).toMatch(/pull before you push/i);
		expect(results[0].error).toContain("status");
		expect(results[0].error).not.toMatch(/immutable/i);
	});

	// superseded_by moves through the same route and belongs on the same side of
	// the branch. Both lifecycle fields differ at once here.
	it("treats a stale superseded_by as a lifecycle conflict too", async () => {
		const original = lesson();
		const replacement = lesson();
		await push(machineToken, [original, replacement]);

		await SELF.fetch(`${BASE}/lessons/${original.id}/status`, {
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

		const stale = await push(machineToken, [original]);

		const { results } = (await stale.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("conflict");
		expect(results[0].error).toContain("superseded_by");
		expect(results[0].error).not.toMatch(/immutable/i);
	});

	// A rewrite that also carries a stale status is still a rewrite. The branch
	// must key on whether ANY content field differs, not on whether a lifecycle
	// field happens to be among them.
	it("still reports immutability when content differs alongside the lifecycle", async () => {
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

		const both = await push(machineToken, [
			{ ...written, claim: "Rewritten while also being stale" },
		]);

		const { results } = (await both.json()) as {
			results: Array<{ outcome: string; error: string }>;
		};
		expect(results[0].outcome).toBe("conflict");
		expect(results[0].error).toMatch(/immutable/i);
		expect(results[0].error).toContain("claim");
		expect(results[0].error).not.toMatch(/pull before you push/i);
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

	// One push, one contiguous block. The concurrency this protects against is
	// exercised where it can be: db/lessons.test.ts drives two batches at once.
	it("gives one push a contiguous block of sequence numbers", async () => {
		const response = await push(machineToken, [lesson(), lesson(), lesson()]);

		const { results } = (await response.json()) as {
			results: Array<{ seq: number }>;
		};
		expect(results.map((r) => r.seq)).toEqual([1, 2, 3]);
	});

	// Only lessons that are actually written may take a number. A rejected
	// lesson consuming one would leave a hole that the client's contiguity check
	// reads as a lost lesson - the exact failure the dense sequence exists to
	// make loud, fired on healthy data.
	it("spends no sequence number on a lesson it rejects", async () => {
		const response = await push(machineToken, [
			lesson(),
			lesson({ schema_version: 99 }),
			lesson(),
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; seq?: number }>;
		};
		expect(results.map((r) => r.outcome)).toEqual([
			"created",
			"invalid",
			"created",
		]);
		expect(results.map((r) => r.seq)).toEqual([1, undefined, 2]);

		const rows = await db()
			.prepare("SELECT seq FROM lesson_feed ORDER BY seq")
			.all<{ seq: number }>();
		expect(rows.results?.map((row) => row.seq)).toEqual([1, 2]);
	});

	// A no-op consumes no number either, so a batch mixing fresh lessons with
	// ones the mirror already holds still numbers the fresh ones densely.
	it("spends no sequence number on a no-op", async () => {
		const held = lesson();
		await push(machineToken, [held]);

		const response = await push(machineToken, [held, lesson()]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; seq?: number }>;
		};
		expect(results.map((r) => r.outcome)).toEqual(["noop", "created"]);
		expect(results[1].seq).toBe(2);
	});

	// An id repeated inside ONE request. The batch write claims each id once, so
	// the second appearance has to be answered from what was actually stored
	// rather than from what the request asked for.
	it("reconciles an id that repeats inside one request", async () => {
		const twice = lesson();
		const response = await push(machineToken, [
			twice,
			twice,
			{ ...twice, claim: "A different claim under the same id" },
		]);

		const { results } = (await response.json()) as {
			results: Array<{ outcome: string; seq?: number }>;
		};
		expect(results.map((r) => r.outcome)).toEqual([
			"created",
			"noop",
			"conflict",
		]);
		expect(results[0].seq).toBe(1);

		const stored = await db()
			.prepare("SELECT COUNT(*) AS n FROM lessons")
			.first<{ n: number }>();
		expect(stored?.n).toBe(1);
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
