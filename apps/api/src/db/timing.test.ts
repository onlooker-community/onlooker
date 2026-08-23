import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timedD1 } from "./timing.js";

type ConsoleSpy = { mock: { calls: unknown[][] } } & {
	mockImplementation: (fn: () => void) => unknown;
	mockRestore: () => void;
};

/** Every d1_timing line emitted during a test, already parsed. */
function emitted(spy: ConsoleSpy): Array<Record<string, unknown>> {
	return spy.mock.calls
		.map((args: unknown[]) => {
			try {
				return JSON.parse(String(args[0])) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter(
			(line: Record<string, unknown> | null): line is Record<string, unknown> =>
				line !== null && line.event === "d1_timing",
		);
}

let spy: ConsoleSpy;

beforeEach(() => {
	spy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	spy.mockRestore();
});

describe("timedD1", () => {
	it("emits one line per executed query", async () => {
		await timedD1(env.DB).prepare("SELECT 1 AS one").all();

		expect(emitted(spy)).toHaveLength(1);
	});

	// The whole point of the module. If exec is missing the line is still
	// emitted, but trip is null and the measurement says nothing - so the
	// presence of a number here is what makes the log worth querying.
	it("reports D1's execution time and derives the round trip", async () => {
		await timedD1(env.DB).prepare("SELECT 1 AS one").all();

		const [line] = emitted(spy);
		expect(typeof line.exec_ms).toBe("number");
		expect(typeof line.wall_ms).toBe("number");
		expect(typeof line.trip_ms).toBe("number");
		expect(line.trip_ms).toBe(
			Math.max(
				0,
				Math.round(
					((line.wall_ms as number) - (line.exec_ms as number)) * 1000,
				) / 1000,
			),
		);
	});

	// bind() returns a NEW statement. Without following it, every parameterized
	// query - which is every real query in this codebase - would go untimed
	// while the suite stayed green on the unparameterized ones.
	it("keeps timing across bind()", async () => {
		await timedD1(env.DB)
			.prepare("SELECT ? AS bound")
			.bind(7)
			.first<{ bound: number }>();

		expect(emitted(spy)).toHaveLength(1);
	});

	it("labels the statement by verb, not by its text", async () => {
		await timedD1(env.DB).prepare("SELECT 1 AS one").all();

		const [line] = emitted(spy);
		expect(line.verb).toBe("SELECT");
		// The query text must not travel into the log.
		expect(JSON.stringify(line)).not.toContain("SELECT 1 AS one");
	});

	it("times a batch as one operation, not one line per statement", async () => {
		const db = timedD1(env.DB);
		await db.batch([
			db.prepare("SELECT 1 AS one"),
			db.prepare("SELECT 2 AS two"),
		]);

		const lines = emitted(spy);
		expect(lines).toHaveLength(1);
		expect(lines[0].verb).toBe("BATCH");
	});

	it("still returns the query's real results", async () => {
		const result = await timedD1(env.DB)
			.prepare("SELECT 42 AS answer")
			.first<{ answer: number }>();

		expect(result?.answer).toBe(42);
	});

	// A logging failure must never take down the query it was measuring.
	it("survives a logger that throws", async () => {
		spy.mockImplementation(() => {
			throw new Error("log sink is down");
		});

		const result = await timedD1(env.DB)
			.prepare("SELECT 1 AS one")
			.first<{ one: number }>();

		expect(result?.one).toBe(1);
	});

	// The reason batch() is timed as one operation, made concrete. onlooker-ujy
	// measured D1 at a p50 of 43 ms wall against 0.182 ms of execution, so what a
	// request pays is the number of crossings, not the work. /auth/refresh made
	// four; rotating the refresh token as a batch removes one.
	//
	// This asserts the crossing count directly rather than trusting that a call
	// named "batch" makes one. Unpicked back into a delete and an insert, it
	// emits two lines and this fails - which is the regression the latency half
	// of onlooker-1hp is guarding against, separate from the atomicity half
	// covered in queries.test.ts.
	it("reports a token rotation as one crossing, not two", async () => {
		const { createUser, rotateRefreshToken, storeRefreshToken } = await import(
			"./queries.js"
		);

		// Setup goes through the UNWRAPPED binding so it emits no timing lines and
		// the count below is only the rotation.
		const user = await createUser(env.DB, "trip@example.com", "hash");
		const expires = new Date(Date.now() + 60_000);
		await storeRefreshToken(env.DB, user.id, "old-token", expires);

		spy.mock.calls.length = 0;

		await rotateRefreshToken(
			timedD1(env.DB),
			"old-token",
			user.id,
			"new-token",
			expires,
		);

		const lines = emitted(spy);
		expect(lines).toHaveLength(1);
		expect(lines[0].verb).toBe("BATCH");
	});

	// The wrapper has to be invisible to drizzle, since that is how most of this
	// codebase reaches D1.
	it("does not disturb drizzle", async () => {
		const { drizzle } = await import("drizzle-orm/d1");
		const { users } = await import("@onlooker/db");

		await drizzle(timedD1(env.DB)).select().from(users).limit(1);

		expect(emitted(spy).length).toBeGreaterThan(0);
	});
});
