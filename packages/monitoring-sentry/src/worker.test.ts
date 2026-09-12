import type { ExportedHandler } from "@cloudflare/workers-types";
import { withSentry } from "@sentry/cloudflare";
import { describe, expect, it, vi } from "vitest";
import { PROPAGATION_HEADERS, withMonitoring } from "./worker";

vi.mock("@sentry/cloudflare", () => ({
	withSentry: vi.fn((_options: unknown, handler: unknown) => handler),
}));

type Env = { MONITORING_DSN?: string };

describe("withMonitoring", () => {
	it("resolves config from each request's env, with the privacy policy applied", () => {
		const handler: ExportedHandler<Env> = {};

		const wrapped = withMonitoring(
			(env: Env) => ({ dsn: env.MONITORING_DSN, environment: "production" }),
			handler,
		);

		expect(wrapped).toBe(handler);
		const optionsFor = vi.mocked(withSentry).mock.calls[0]?.[0] as (
			env: Env,
		) => { dsn?: string; sendDefaultPii?: boolean };
		expect(
			optionsFor({ MONITORING_DSN: "https://x@o1.ingest.sentry.io/1" }),
		).toMatchObject({
			dsn: "https://x@o1.ingest.sentry.io/1",
			sendDefaultPii: false,
		});
	});

	it("names the headers CORS must allow for traces to continue", () => {
		expect(PROPAGATION_HEADERS).toEqual(["sentry-trace", "baggage"]);
	});
});
