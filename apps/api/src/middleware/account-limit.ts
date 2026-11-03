import { monitor } from "../monitoring";
import { ApiError, type WorkerEnv } from "../types";

/**
 * The per-account circuit breaker (ONL-222).
 *
 * Every signed-in request counts against one budget per account, whatever
 * credential carried it: a browser session and every machine token on the
 * account share it. It's sized as a circuit breaker, not a quota. The worst
 * legitimate sync measured is about 74 requests in 15-30 seconds, two machines
 * doing that at once come to about 600 a minute, and the limit sits above
 * both. What it stops is a runaway script or a stolen token. See
 * docs/superpowers/specs/2026-11-03-account-rate-limit-design.md.
 *
 * The Workers rate limiting binding counts approximately, per Cloudflare
 * location, which a circuit breaker can afford. It adds no D1 query, where a
 * D1 counter would add a write to every request in order to protect D1 writes.
 */
export const ACCOUNT_LIMIT = { requests: 1000, periodSeconds: 60 } as const;

/** Injectable because the Workers pool cannot mock modules. */
export type AccountLimitDeps = {
	monitor: Pick<typeof monitor, "captureException">;
};

const realDeps: AccountLimitDeps = { monitor };

export function accountLimitKey(userId: string): string {
	return `user:${userId}`;
}

/**
 * Resolve if the account may make this request, or throw a 429.
 *
 * `route` is the matched route's method and pattern, never the concrete path,
 * so a report groups by route rather than by lesson id.
 *
 * Fails open. A missing limiter, which is the test pool's and any
 * misconfigured environment's state, allows the request silently; a throwing
 * one allows it and reports. A broken limiter must not take the API down.
 */
export async function enforceAccountLimit(
	env: WorkerEnv,
	userId: string,
	route: string,
	deps: AccountLimitDeps = realDeps,
): Promise<void> {
	const limiter = env.ACCOUNT_LIMITER;
	if (!limiter) return;

	let allowed: boolean;
	try {
		({ success: allowed } = await limiter.limit({
			key: accountLimitKey(userId),
		}));
	} catch (error) {
		deps.monitor.captureException(error, {
			tags: { kind: "account_limiter_failed", route },
			fingerprint: ["account_limiter_failed"],
		});
		return;
	}
	if (allowed) return;

	await reportTrip(env, userId, route, deps);
	throw new ApiError(
		429,
		"rate_limited",
		"Too many requests from this account. Try again in a minute.",
		undefined,
		// The binding doesn't say when its window resets, so the period is the
		// honest upper bound.
		{ "Retry-After": String(ACCOUNT_LIMIT.periodSeconds) },
	);
}

/**
 * Report a refusal, at most once a minute per account per location.
 *
 * A runaway refused a thousand times a minute must not become a thousand
 * Sentry events, so the gate decides. Without a gate, or with one that throws,
 * nothing is reported: one report per refused request is exactly the flood
 * the gate exists to stop, and the refusal itself still stands.
 */
async function reportTrip(
	env: WorkerEnv,
	userId: string,
	route: string,
	deps: AccountLimitDeps,
): Promise<void> {
	const gate = env.LIMIT_REPORT_GATE;
	if (!gate) return;
	try {
		const { success } = await gate.limit({ key: `report:${userId}` });
		if (!success) return;
	} catch {
		return;
	}
	deps.monitor.captureException(
		new Error(
			`account passed ${ACCOUNT_LIMIT.requests} requests in ${ACCOUNT_LIMIT.periodSeconds}s and is being refused`,
		),
		{
			tags: { kind: "account_rate_limited", route },
			fingerprint: ["account_rate_limited"],
			// An opaque id, not an email. CaptureContext has no per-event user,
			// and setUser is global to the isolate.
			extra: { user_id: userId },
		},
	);
}
