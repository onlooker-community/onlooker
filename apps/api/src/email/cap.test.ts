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
	// The ceiling refusing mail means legitimate mail is being refused for the
	// rest of the day. A per-address cap firing is the system working.
	it("raises an issue when the day's ceiling first refuses", () => {
		const recorder = createRecordingMonitor();
		const { deps } = quiet(recorder);

		reportMailRefusal(
			{ ok: false, scope: "global", first: true, retryAfterMs: 1000 },
			"reset",
			deps,
		);

		expect(recorder.exceptions).toHaveLength(1);
		expect((recorder.exceptions[0]?.error as Error).message).toContain(
			"reset pool",
		);
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
});
