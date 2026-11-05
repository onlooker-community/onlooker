import { describe, expect, it, vi } from "vitest";
import {
	chunkSessionReport,
	classify,
	createClient,
	sessionReportBody,
} from "../api";
import type { SessionSummary } from "../sessions";

const URL_ = "https://api.onlooker.dev/lessons";

describe("classify", () => {
	// Each of these is a different instruction to the user. Collapsing them into
	// one message is exactly the defect this replaces.
	it("calls 401 a credential problem and names the fix", () => {
		const f = classify(401, URL_, {});
		expect(f.kind).toBe("unauthorized");
		expect(f.message).toMatch(/onlooker link/);
	});

	// The failure that hid for two months. It must name the URL, because the
	// whole reason nobody noticed was that the message never said what 404'd.
	it("calls 404 terminal and names the URL", () => {
		const f = classify(404, URL_, {});
		expect(f.kind).toBe("gone");
		expect(f.message).toContain(URL_);
	});

	it("surfaces the API's own message on a 400", () => {
		const f = classify(400, URL_, {
			error: {
				code: "batch_too_large",
				message: "At most 100 lessons per request",
			},
		});
		expect(f.kind).toBe("rejected");
		expect(f.message).toContain("At most 100 lessons per request");
	});

	it("calls 5xx transient and says a retry is worth it", () => {
		const f = classify(503, URL_, {});
		expect(f.kind).toBe("transient");
		expect(f.message).toMatch(/again/i);
	});

	// 429 is the one 4xx that IS worth retrying. Bucketing it with the others
	// would tell the user to give up on a request that would succeed.
	it("calls 429 transient rather than terminal", () => {
		expect(classify(429, URL_, {}).kind).toBe("transient");
	});

	// The `rejected` branch surfaces the API's own sentence and the transient
	// one used to drop it, leaving a bare status code to go look up. "Retry
	// after 30s" and "upstream database unavailable" are both a retry, but they
	// are not the same wait.
	it("surfaces the API's own message on a transient failure too", () => {
		const f = classify(429, URL_, {
			error: { code: "rate_limited", message: "Retry after 30s" },
		});
		expect(f.kind).toBe("transient");
		expect(f.message).toContain("Retry after 30s");
		expect(f.message).toMatch(/again/i);
	});
});

describe("createClient", () => {
	function withFetch(status: number, body: unknown) {
		return vi.fn().mockResolvedValue({
			ok: status < 400,
			status,
			json: async () => body,
		});
	}

	it("sends the token as a bearer on verify", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://api.onlooker.dev/lessons?since=0&limit=1");
		expect(init.headers.Authorization).toBe("Bearer tok");
	});

	// GET /lessons is machine-authenticated; /api/lessons is the browser's
	// session route and would reject every valid machine token. Pinning the URL
	// is what stops that mix-up returning.
	it("verifies against the machine route, never the browser one", async () => {
		const fetchImpl = withFetch(200, { lessons: [], has_more: false });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).verify();
		expect(fetchImpl.mock.calls[0][0]).not.toContain("/api/lessons");
	});

	it("throws a classified error rather than a bare status", async () => {
		const client = createClient(
			"https://api.onlooker.dev",
			"tok",
			withFetch(401, {}),
		);
		await expect(client.verify()).rejects.toMatchObject({
			failure: { kind: "unauthorized" },
		});
	});

	// A refused connection never reaches a status code, and it is the case the
	// user can actually do something about by trying again.
	it("treats a network failure as transient", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const client = createClient("https://api.onlooker.dev", "tok", fetchImpl);
		await expect(client.push([])).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
	});

	it("posts lessons as a bare array under `lessons`", async () => {
		const fetchImpl = withFetch(200, { results: [] });
		await createClient("https://api.onlooker.dev", "tok", fetchImpl).push([
			{ id: "x" },
		]);
		const [, init] = fetchImpl.mock.calls[0];
		expect(JSON.parse(init.body)).toEqual({ lessons: [{ id: "x" }] });
	});
});

// ONL-242. The API refuses an account past 1,000 requests a minute with 429
// and `Retry-After: 60`. Telling someone to run the command again by hand is
// the wait they would have done anyway, so the client does it for them - once.
describe("createClient on 429", () => {
	/** Answers each call with the next response in `statuses`, then 200. */
	function sequence(
		statuses: Array<{ status: number; retryAfter?: string }>,
		body: unknown = { results: [] },
	) {
		let call = 0;
		return vi.fn().mockImplementation(async () => {
			const next = statuses[call++];
			const status = next?.status ?? 200;
			return {
				ok: status < 400,
				status,
				headers: new Headers(
					next?.retryAfter === undefined
						? {}
						: { "Retry-After": next.retryAfter },
				),
				json: async () => (status < 400 ? body : {}),
			};
		});
	}

	const retrying = (fetchImpl: typeof fetch) => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const onWait = vi.fn();
		const client = createClient("https://api.test", "tok", fetchImpl, {
			sleep,
			onWait,
		});
		return { client, sleep, onWait };
	};

	it("waits for Retry-After and retries once", async () => {
		const fetchImpl = sequence([{ status: 429, retryAfter: "7" }]);
		const { client, sleep } = retrying(fetchImpl);
		await expect(client.push([{ id: "x" }])).resolves.toEqual({
			results: [],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(7_000);
	});

	it("sends the same request again, body and all", async () => {
		const fetchImpl = sequence([{ status: 429, retryAfter: "1" }]);
		await retrying(fetchImpl).client.push([{ id: "x" }]);
		const [first, second] = fetchImpl.mock.calls;
		expect(second).toEqual(first);
	});

	it("says it is waiting, and for how long", async () => {
		const { client, onWait } = retrying(
			sequence([{ status: 429, retryAfter: "12" }]),
		);
		await client.push([]);
		expect(onWait).toHaveBeenCalledWith(12);
	});

	// The cap is what keeps a misbehaving header from parking a sync for an
	// hour, and the floor keeps "0" from turning into a hot retry.
	it.each([
		["3600", 60],
		["0", 1],
		["-5", 1],
	])("clamps Retry-After %s to %ds", async (header, seconds) => {
		const { client, sleep } = retrying(
			sequence([{ status: 429, retryAfter: header }]),
		);
		await client.push([]);
		expect(sleep).toHaveBeenCalledWith(seconds * 1000);
	});

	it("reads an HTTP-date Retry-After", async () => {
		const at = new Date(Date.now() + 20_000).toUTCString();
		const { client, sleep } = retrying(
			sequence([{ status: 429, retryAfter: at }]),
		);
		await client.push([]);
		const waited = sleep.mock.calls[0][0] as number;
		// toUTCString drops milliseconds, so allow a second either way.
		expect(waited).toBeGreaterThanOrEqual(18_000);
		expect(waited).toBeLessThanOrEqual(21_000);
	});

	// The API's limit is per minute, so a 429 without the header most likely
	// clears when the minute does. Retrying sooner would just spend the retry.
	it.each([
		[undefined, "missing"],
		["soon", "unreadable"],
	])("waits the full cap when Retry-After is %s (%s)", async (header, _) => {
		const { client, sleep } = retrying(
			sequence([{ status: 429, retryAfter: header }]),
		);
		await client.push([]);
		expect(sleep).toHaveBeenCalledWith(60_000);
	});

	it("gives up after one retry, still transient", async () => {
		const fetchImpl = sequence([
			{ status: 429, retryAfter: "1" },
			{ status: 429, retryAfter: "1" },
		]);
		const { client, sleep } = retrying(fetchImpl);
		await expect(client.push([])).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	// A sync makes several requests. If the wait did not clear the limit, it
	// will not clear for the next request either, and waiting a minute per
	// request would hold a sync for several minutes to fail the same way.
	it("stops waiting once a wait has not cleared the limit", async () => {
		const fetchImpl = sequence([
			{ status: 429, retryAfter: "1" },
			{ status: 429, retryAfter: "1" },
			{ status: 429, retryAfter: "1" },
		]);
		const { client, sleep } = retrying(fetchImpl);
		await expect(client.push([])).rejects.toBeDefined();
		await expect(client.readDelta(0, 50)).rejects.toMatchObject({
			failure: { kind: "transient" },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("waits again for a later request once a retry has succeeded", async () => {
		const fetchImpl = sequence([
			{ status: 429, retryAfter: "1" },
			{ status: 200 },
			{ status: 429, retryAfter: "1" },
		]);
		const { client, sleep } = retrying(fetchImpl);
		await client.push([]);
		await client.push([]);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	// Only 429 carries a promise that waiting helps. A 503 is retried by the
	// person running the command, as before.
	it.each([401, 500, 503])("does not retry a %d", async (status) => {
		const fetchImpl = sequence([{ status, retryAfter: "1" }]);
		const { client, sleep } = retrying(fetchImpl);
		await expect(client.push([])).rejects.toBeDefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});

/** A session summary whose plugin list pads it to roughly `pad` bytes. */
const summary = (session_id: string, pad = 0): SessionSummary => ({
	session_id,
	machine_id: null,
	started_at: "2026-10-23T10:00:00.000Z",
	ended_at: null,
	event_count: 25,
	counts_by_prefix: { tool: 25 },
	counts_by_type: { "tool.shell.exec": 25 },
	counts_by_project: {},
	plugins: pad > 0 ? ["x".repeat(pad)] : [],
	prompts: 1,
	compactions: 0,
});

const bytes = (text: string) => new TextEncoder().encode(text).length;

// ONL-188. The API refuses any sessions body over 256 KiB, and a week on a
// busy machine is 582 sessions and ~300 KB. One request for the whole window
// meant no session was reported at all.
describe("chunkSessionReport", () => {
	it("keeps every chunk's wire body within the budget", () => {
		const summaries = Array.from({ length: 50 }, (_, i) =>
			summary(`s${i}`, 200),
		);

		const chunks = chunkSessionReport(summaries, 2_000);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(bytes(sessionReportBody(chunk))).toBeLessThanOrEqual(2_000);
		}
	});

	// Measured against the bytes actually sent, not an estimate: a budget
	// that undercounts lets a chunk through that the API then refuses.
	it("fills a chunk to the budget exactly when it can", () => {
		const summaries = [summary("a"), summary("b"), summary("c")];
		const twoFit = bytes(sessionReportBody(summaries.slice(0, 2)));

		const chunks = chunkSessionReport(summaries, twoFit);

		expect(chunks.map((c) => c.length)).toEqual([2, 1]);
	});

	it("keeps every session, in order", () => {
		const summaries = Array.from({ length: 30 }, (_, i) =>
			summary(`s${i}`, 100),
		);

		const chunks = chunkSessionReport(summaries, 1_000);

		expect(chunks.flat()).toEqual(summaries);
	});

	// One session larger than the budget still goes, alone. Dropping it
	// would be silent; holding up the rest behind it would be worse.
	it("sends a session larger than the budget on its own", () => {
		const summaries = [summary("a"), summary("huge", 5_000), summary("b")];

		const chunks = chunkSessionReport(summaries, 1_000);

		expect(chunks.map((c) => c.map((s) => s.session_id))).toEqual([
			["a"],
			["huge"],
			["b"],
		]);
	});

	it("makes no chunk from nothing", () => {
		expect(chunkSessionReport([], 1_000)).toEqual([]);
	});

	it("is the body reportSessions sends", async () => {
		let sent = "";
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (_url: string, init: { body: string }) => {
				sent = init.body;
				return { ok: true, status: 200, json: async () => ({ stored: 1 }) };
			});

		await createClient("https://api.test", "tok", fetchImpl).reportSessions([
			summary("a"),
		]);

		expect(sent).toBe(sessionReportBody([summary("a")]));
	});
});

describe("readDelta", () => {
	it("asks the machine-side route with the cursor and limit", async () => {
		let seen = "";
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			seen = url;
			return {
				ok: true,
				status: 200,
				json: async () => ({ lessons: [], cursor: 7, has_more: false }),
			};
		});

		await createClient("https://api.test", "tok", fetchImpl).readDelta(7, 50);

		// GET /lessons, not /api/lessons. A machine token authenticates the
		// machine-side delta read; the browser route would reject it - the same
		// distinction `verify` documents.
		expect(seen).toBe("https://api.test/lessons?since=7&limit=50");
	});

	it("returns the window verbatim", async () => {
		const body = {
			lessons: [{ seq: 8, lesson: { id: "01KZ45MKAM734ZS7JK24D2DK0R" } }],
			cursor: 8,
			has_more: true,
		};
		const fetchImpl = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, json: async () => body });

		const got = await createClient(
			"https://api.test",
			"tok",
			fetchImpl,
		).readDelta(7, 50);

		expect(got).toEqual(body);
	});

	// Failures go through the same classifier as every other call, so a dead
	// endpoint or a revoked token reads the same here as it does on push.
	it("classifies a failure like every other call", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({ error: "invalid_token" }),
		});

		await expect(
			createClient("https://api.test", "tok", fetchImpl).readDelta(0, 50),
		).rejects.toMatchObject({ failure: { kind: "unauthorized" } });
	});
});
