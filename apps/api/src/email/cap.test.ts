import { createRecordingMonitor } from "@onlooker/monitoring/testing";
import { describe, expect, it } from "vitest";
import { mailRateLimitError, reportMailRefusal } from "./cap.js";

const quiet = (recorder: ReturnType<typeof createRecordingMonitor>) => {
	const lines: string[] = [];
	return {
		lines,
		deps: { monitor: recorder.monitor, log: (l: string) => lines.push(l) },
	};
};

describe("reportMailRefusal", () => {
	// A pool refusing mail means legitimate mail of that kind is being refused
	// for the rest of the day. A per-address cap firing is the system working.
	it.each([
		"reset",
		"verify",
		"invite",
	] as const)("raises an issue, tagged with the kind, when the %s pool first refuses", (kind) => {
		const recorder = createRecordingMonitor();
		const { deps } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "global", first: true, retryAfterMs: 1000 },
			kind,
			deps,
		);

		expect(recorder.exceptions).toHaveLength(1);
		expect((recorder.exceptions[0]?.error as Error).message).toContain(
			`${kind} pool`,
		);
		expect(recorder.exceptions[0]?.context?.tags).toEqual({
			kind: "mail_global_ceiling",
			mail_kind: kind,
		});
	});

	// Once a day: a looped invite would otherwise raise an event per request.
	it("only logs a later refusal at the ceiling the same day", () => {
		const recorder = createRecordingMonitor();
		const { deps, lines } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "global", first: false, retryAfterMs: 1000 },
			"invite",
			deps,
		);

		expect(recorder.exceptions).toHaveLength(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: "mail_global_ceiling",
			kind: "invite",
		});
	});

	it("raises nothing when one address is capped", () => {
		const recorder = createRecordingMonitor();
		const { deps } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "address", retryAfterMs: 1000 },
			"invite",
			deps,
		);

		expect(recorder.exceptions).toHaveLength(0);
	});

	// The inviter cap firing is the cap working, as an address cap is.
	it("raises nothing and logs mail_inviter_capped when an inviter is capped", () => {
		const recorder = createRecordingMonitor();
		const { deps, lines } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "inviter", retryAfterMs: 1000 },
			"invite",
			deps,
		);

		expect(recorder.exceptions).toHaveLength(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: "mail_inviter_capped",
			kind: "invite",
		});
	});

	it("logs one structured line either way, naming the kind and never an address", () => {
		const recorder = createRecordingMonitor();
		const { deps, lines } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "address", retryAfterMs: 1000 },
			"verify",
			deps,
		);

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: "mail_address_capped",
			kind: "verify",
		});
	});
});

describe("mailRateLimitError", () => {
	// The same code and header the login backoff answers, so a client handles
	// one shape of refusal.
	it("is a 429 rate_limit_exceeded with Retry-After in whole seconds, rounded up", () => {
		const error = mailRateLimitError({
			ok: false,
			scope: "address",
			retryAfterMs: 1500,
		});

		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limit_exceeded");
		expect(error.headers).toEqual({ "Retry-After": "2" });
	});

	it("never says to retry after zero seconds", () => {
		const error = mailRateLimitError({
			ok: false,
			scope: "global",
			first: false,
			retryAfterMs: 0,
		});

		expect(error.headers).toEqual({ "Retry-After": "1" });
	});

	// The owner can already see their own invites, so saying so leaks nothing.
	it("tells a capped inviter it is their invites, with the window's Retry-After", () => {
		const error = mailRateLimitError({
			ok: false,
			scope: "inviter",
			retryAfterMs: 22 * 60 * 60_000,
		});

		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limit_exceeded");
		expect(error.message).toBe(
			"You have sent too many invites today. Try again later.",
		);
		expect(error.headers).toEqual({ "Retry-After": String(22 * 60 * 60) });
	});
});
