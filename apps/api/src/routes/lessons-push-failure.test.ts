import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { SequenceExhaustedError } from "../db/lessons.js";
import { errorHandler } from "../middleware/error.js";
import {
	BASE,
	lesson,
	mintMachineToken,
	resetLessonCounter,
} from "../test-support/lessons.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { handlePushLessons, handleTransitionLesson } from "./lessons.js";

/**
 * What happens to a batch that cannot be written.
 *
 * These call the handlers directly rather than through SELF, because the
 * failures they cover are D1 failures and there is no request that provokes one
 * through the worker. The proxy below is the whole reason the file exists:
 * every one of these paths was unreachable from a test before, and every one of
 * them ended in a 500 with no `results` array at all - the "told only that the
 * batch failed, so re-push all twenty" outcome the per-item design exists to
 * prevent, reached from inside the mechanism built to prevent it.
 */
const db = () => env.DB;
const REAL_ENV = env as unknown as WorkerEnv;

let machineToken: string;
let userId: string;

/** The real binding, with db.batch() failing the way D1 can under load. */
function batchFailsWith(error: Error): WorkerEnv {
	const broken = new Proxy(REAL_ENV.DB, {
		get(target, property, receiver) {
			if (property === "batch") return () => Promise.reject(error);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as D1Database;

	return { ...REAL_ENV, DB: broken };
}

const SEQ_COLLISION =
	"D1_ERROR: UNIQUE constraint failed: lesson_feed.user_id, lesson_feed.seq: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";

function pushRequest(token: string, lessons: unknown[]): Request {
	return new Request(`${BASE}/lessons`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ lessons }),
	});
}

/** Run a handler and hand back whatever it threw, if anything. */
async function thrownBy(work: Promise<Response>): Promise<unknown> {
	return work.then(
		() => null,
		(error) => error,
	);
}

beforeEach(async () => {
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	machineToken = await mintMachineToken("push@example.com");
	const user = await db()
		.prepare("SELECT id FROM users WHERE email = ?")
		.bind("push@example.com")
		.first<{ id: string }>();
	userId = user?.id ?? "";
	resetLessonCounter();
});

describe("POST /lessons when the write fails", () => {
	it("keeps the verdicts already reached for the rest of the batch", async () => {
		const response = await handlePushLessons(
			pushRequest(machineToken, [
				lesson(),
				lesson({ schema_version: 99 }),
				lesson(),
			]),
			batchFailsWith(new Error("D1_ERROR: Network connection lost")),
		);

		// A response at all, rather than a 500 with no results array.
		expect(response.status).toBe(200);
		const { results } = (await response.json()) as {
			results: Array<{ id: string; outcome: string; error?: string }>;
		};

		expect(results.map((r) => r.outcome)).toEqual([
			"error",
			"invalid",
			"error",
		]);

		// The surviving verdict is the point. "invalid" tells the client this
		// lesson will never be accepted, so it stops sending it; "error" tells it
		// the other two are worth retrying. Collapsing both into one 500 loses
		// that distinction and the client re-pushes all three forever.
		expect(results[1].error).toBeTruthy();
	});

	it("names each failed lesson so the client knows what to retry", async () => {
		const one = lesson();
		const two = lesson();

		const response = await handlePushLessons(
			pushRequest(machineToken, [one, two]),
			batchFailsWith(new Error("D1_ERROR: Network connection lost")),
		);

		const { results } = (await response.json()) as {
			results: Array<{ id: string; outcome: string }>;
		};
		expect(results.map((r) => r.id)).toEqual([one.id, two.id]);
	});

	// The failure text is a D1 string we do not control, and errorHandler echoes
	// error.message verbatim. Anything internal in it would reach a client.
	it("does not echo the database's own error text", async () => {
		const response = await handlePushLessons(
			pushRequest(machineToken, [lesson()]),
			batchFailsWith(
				new Error(`D1_ERROR: something about user ${userId} went wrong`),
			),
		);

		expect(await response.text()).not.toContain(userId);
	});

	// The spec: "Retry is bounded; exhausting it is a 503, never a partial
	// write." A plain Error made this a 500 instead.
	it("answers 503 for sustained sequence contention", async () => {
		const thrown = await thrownBy(
			handlePushLessons(
				pushRequest(machineToken, [lesson(), lesson()]),
				batchFailsWith(new Error(SEQ_COLLISION)),
			),
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).status).toBe(503);
		expect(errorHandler(thrown).status).toBe(503);
	});

	// Separate from the status, because it is a separate failure. errorHandler
	// echoes a bare Error's message verbatim into the body, and the message the
	// named class replaced put the internal user id there - so provoking
	// contention published it. Asserted first-and-alone so nothing else in the
	// test can fail ahead of it and hide that it stopped checking.
	it("does not name the user in the contention response", async () => {
		const thrown = await thrownBy(
			handlePushLessons(
				pushRequest(machineToken, [lesson(), lesson()]),
				batchFailsWith(new Error(SEQ_COLLISION)),
			),
		);

		expect(await errorHandler(thrown).text()).not.toContain(userId);
	});

	it("writes nothing at all when it gives up", async () => {
		await thrownBy(
			handlePushLessons(
				pushRequest(machineToken, [lesson(), lesson()]),
				batchFailsWith(new Error(SEQ_COLLISION)),
			),
		);

		const lessons = await db()
			.prepare("SELECT COUNT(*) AS n FROM lessons")
			.first<{ n: number }>();
		const feed = await db()
			.prepare("SELECT COUNT(*) AS n FROM lesson_feed")
			.first<{ n: number }>();

		expect(lessons?.n).toBe(0);
		expect(feed?.n).toBe(0);
	});
});

describe("POST /lessons/:id/status when the write fails", () => {
	/** Retract a lesson through the handler, against the env given. */
	async function retract(id: string, against: WorkerEnv): Promise<unknown> {
		return thrownBy(
			handleTransitionLesson(
				new Request(`${BASE}/lessons/${id}/status`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${machineToken}`,
					},
					body: JSON.stringify({ status: "retracted", superseded_by: null }),
				}),
				against,
			),
		);
	}

	// The transition route assigns a sequence too, and reached the same bare
	// Error by the same path.
	it("answers 503 for sustained sequence contention", async () => {
		const written = lesson();
		await handlePushLessons(pushRequest(machineToken, [written]), REAL_ENV);

		const thrown = await retract(
			written.id,
			batchFailsWith(new Error(SEQ_COLLISION)),
		);

		expect(thrown).toBeInstanceOf(ApiError);
		expect((thrown as ApiError).status).toBe(503);
		expect(errorHandler(thrown).status).toBe(503);
	});

	it("does not name the user in the contention response", async () => {
		const written = lesson();
		await handlePushLessons(pushRequest(machineToken, [written]), REAL_ENV);

		const thrown = await retract(
			written.id,
			batchFailsWith(new Error(SEQ_COLLISION)),
		);

		expect(await errorHandler(thrown).text()).not.toContain(userId);
	});
});

describe("SequenceExhaustedError", () => {
	// errorHandler echoes error.message verbatim into the response body, so the
	// user id must not be in it - while still being available to a log line.
	it("carries the user id as a property, never in the message", () => {
		const error = new SequenceExhaustedError("user_0123456789abcdef", 5);

		expect(error.message).not.toContain("user_0123456789abcdef");
		expect(error.userId).toBe("user_0123456789abcdef");
		expect(error.attempts).toBe(5);
		expect(errorHandler(error)).toBeInstanceOf(Response);
	});
});
