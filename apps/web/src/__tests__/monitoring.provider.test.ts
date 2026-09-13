import { describe, expect, it, vi } from "vitest";

// Only the two entry points the provider actually calls. Mocked rather than
// initialized for real, because Sentry.init on a live SDK registers a client
// on @sentry/core's global carrier that later tests in this file would inherit.
const init = vi.fn();
vi.mock("@sentry/react", () => ({
	init: (...args: unknown[]) => init(...args),
	browserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));

import { routeName, startProvider } from "../monitoring.provider";

function initOptions(): Record<string, unknown> {
	return init.mock.calls[0]?.[0] as Record<string, unknown>;
}

// A trace named for its URL makes every lesson its own transaction, and puts a
// single-use credential in the name of any trace that starts on a reset link.
describe("routeName", () => {
	it("names a reset link for its pattern, not its token", () => {
		expect(routeName(`/reset-password/${"a".repeat(64)}`)).toBe(
			"/reset-password/:token",
		);
		expect(routeName(`/verify-email/${"b".repeat(64)}`)).toBe(
			"/verify-email/:token",
		);
	});

	it("names every lesson as one route", () => {
		expect(routeName("/lessons/01J8Z4K2M3N4P5Q6R7S8T9V0W1")).toBe(
			"/lessons/:id",
		);
	});

	it("leaves a route with no parameter as it is", () => {
		expect(routeName("/lessons")).toBe("/lessons");
		expect(routeName("/settings")).toBe("/settings");
	});
});

// A bundle is cached in browsers long after the deploy that produced it, so
// "which code is this" cannot be read from the clock or from what is currently
// deployed. The build has to say, and this is where it says it.
describe("startProvider", () => {
	const config = {
		dsn: "https://k@o1.ingest.sentry.io/1",
		environment: "production",
		apiBaseUrl: "https://api.onlooker.dev",
	} as const;

	it("stamps events with the commit the bundle was built from", () => {
		init.mockClear();

		startProvider({ ...config, release: "0f1e2d3c4b5a" });

		expect(initOptions().release).toBe("0f1e2d3c4b5a");
	});

	// A local build has no commit to claim. Undefined leaves the events
	// unreleased, which is honest; inventing one would create a Sentry release
	// that no source map upload will ever match.
	it("leaves the release unset when the build supplied none", () => {
		init.mockClear();

		startProvider(config);

		expect(initOptions().release).toBeUndefined();
	});
});
