import { env } from "cloudflare:test";
import type { RateLimit } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkerEnv } from "../types";
import {
	ACCOUNT_LIMIT,
	type AccountLimitDeps,
	accountLimitKey,
	enforceAccountLimit,
	resetLimiterFailureReport,
} from "./account-limit";

/**
 * Unit tests against fake bindings. The real binding only counts in a
 * deployed worker, and nothing here should need 1,000 requests to see a
 * refusal.
 */

const ROUTE = "GET /api/projects";

/** A limiter that answers `success` and records every key it was asked. */
function fakeLimiter(success: boolean): RateLimit & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success };
		},
	};
}

/** A gate that allows the first call per key and refuses the rest. */
function onceGate(): RateLimit {
	const seen = new Set<string>();
	return {
		limit: async ({ key }) => {
			const success = !seen.has(key);
			seen.add(key);
			return { success };
		},
	};
}

function deps(): AccountLimitDeps & {
	captured: Array<{ error: unknown; context: unknown }>;
} {
	const captured: Array<{ error: unknown; context: unknown }> = [];
	return {
		captured,
		monitor: {
			captureException: (error, context) => {
				captured.push({ error, context });
			},
		},
	};
}

function withBindings(bindings: Partial<WorkerEnv>): WorkerEnv {
	return { ...(env as unknown as WorkerEnv), ...bindings };
}

describe("accountLimitKey", () => {
	it("keys by user id", () => {
		expect(accountLimitKey("u1")).toBe("user:u1");
	});
});

describe("enforceAccountLimit", () => {
	// The failure report's timestamp is module state, shared by every test in
	// this file.
	beforeEach(() => resetLimiterFailureReport());

	it("allows a request the limiter allows, and reports nothing", async () => {
		const limiter = fakeLimiter(true);
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: limiter,
					LIMIT_REPORT_GATE: onceGate(),
				}),
				"u1",
				ROUTE,
				d,
			),
		).resolves.toBeUndefined();
		expect(limiter.keys).toEqual(["user:u1"]);
		expect(d.captured).toEqual([]);
	});

	it("refuses with 429 rate_limited and Retry-After 60", async () => {
		const d = deps();
		const refused = enforceAccountLimit(
			withBindings({
				ACCOUNT_LIMITER: fakeLimiter(false),
				LIMIT_REPORT_GATE: onceGate(),
			}),
			"u1",
			ROUTE,
			d,
		);
		await expect(refused).rejects.toBeInstanceOf(ApiError);
		const error = (await refused.catch((e) => e)) as ApiError;
		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limited");
		expect(error.headers).toEqual({ "Retry-After": "60" });
		expect(ACCOUNT_LIMIT).toEqual({ requests: 1000, periodSeconds: 60 });
	});

	it("reports the first refusal through the gate, not the second", async () => {
		const d = deps();
		const bindings = withBindings({
			ACCOUNT_LIMITER: fakeLimiter(false),
			LIMIT_REPORT_GATE: onceGate(),
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		expect(d.captured).toHaveLength(1);
		expect(d.captured[0].context).toEqual({
			tags: { kind: "account_rate_limited", route: ROUTE },
			fingerprint: ["account_rate_limited"],
			extra: { user_id: "u1" },
		});
	});

	it("gates reports per account", async () => {
		const d = deps();
		const bindings = withBindings({
			ACCOUNT_LIMITER: fakeLimiter(false),
			LIMIT_REPORT_GATE: onceGate(),
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, d).catch(() => {});
		await enforceAccountLimit(bindings, "u2", ROUTE, d).catch(() => {});
		expect(d.captured).toHaveLength(2);
	});

	it("still refuses, without reporting, when the gate is missing", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({ ACCOUNT_LIMITER: fakeLimiter(false) }),
				"u1",
				ROUTE,
				d,
			),
		).rejects.toMatchObject({ status: 429 });
		expect(d.captured).toEqual([]);
	});

	it("still refuses, without reporting, when the gate throws", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: fakeLimiter(false),
					LIMIT_REPORT_GATE: {
						limit: async () => {
							throw new Error("gate down");
						},
					},
				}),
				"u1",
				ROUTE,
				d,
			),
		).rejects.toMatchObject({ status: 429 });
		expect(d.captured).toEqual([]);
	});

	it("fails open, reporting nothing, when the limiter is missing", async () => {
		const d = deps();
		await expect(
			enforceAccountLimit(withBindings({}), "u1", ROUTE, d),
		).resolves.toBeUndefined();
		expect(d.captured).toEqual([]);
	});

	it("fails open and reports when the limiter throws", async () => {
		const d = deps();
		const boom = new Error("limiter down");
		await expect(
			enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: {
						limit: async () => {
							throw boom;
						},
					},
				}),
				"u1",
				ROUTE,
				d,
			),
		).resolves.toBeUndefined();
		expect(d.captured).toEqual([
			{
				error: boom,
				context: {
					tags: { kind: "account_limiter_failed", route: ROUTE },
					fingerprint: ["account_limiter_failed"],
				},
			},
		]);
	});

	it("reports a limiter failure once a minute, not on every request", async () => {
		const d = { ...deps(), now: () => 1_000_000 };
		const bindings = withBindings({
			ACCOUNT_LIMITER: {
				limit: async () => {
					throw new Error("limiter down");
				},
			},
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, d);
		await enforceAccountLimit(bindings, "u2", ROUTE, d);
		await enforceAccountLimit(bindings, "u1", ROUTE, {
			...d,
			now: () => 1_000_000 + 59_999,
		});
		expect(d.captured).toHaveLength(1);
	});

	it("reports a limiter failure again after a minute", async () => {
		const d = deps();
		const bindings = withBindings({
			ACCOUNT_LIMITER: {
				limit: async () => {
					throw new Error("limiter down");
				},
			},
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, {
			...d,
			now: () => 1_000_000,
		});
		await enforceAccountLimit(bindings, "u1", ROUTE, {
			...d,
			now: () => 1_000_000 + 60_000,
		});
		expect(d.captured).toHaveLength(2);
	});

	it("uses the shared monitor when no deps are passed", async () => {
		const { monitor } = await import("../monitoring");
		const capture = vi.spyOn(monitor, "captureException");
		try {
			await enforceAccountLimit(
				withBindings({
					ACCOUNT_LIMITER: fakeLimiter(false),
					LIMIT_REPORT_GATE: onceGate(),
				}),
				"u1",
				ROUTE,
			).catch(() => {});
			expect(capture).toHaveBeenCalledTimes(1);
		} finally {
			capture.mockRestore();
		}
	});
});
