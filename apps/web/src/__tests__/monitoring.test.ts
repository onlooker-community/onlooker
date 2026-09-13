import { beforeEach, describe, expect, it, vi } from "vitest";

// The Workers Logs path is the one client-error-monitor.yml alerts on, so it is
// the one these follow. The provider half of the fanout has no client in tests
// and sends nothing.
const reportClientError = vi.fn();
vi.mock("../lib/reportError", () => ({
	reportClientError: (...args: unknown[]) => reportClientError(...args),
}));

// initMonitoring reaches the provider through a dynamic import, so this stands
// in for the chunk rather than for the SDK inside it.
const startProvider = vi.fn((..._args: unknown[]) => noopMonitor);
vi.mock("../monitoring.provider", () => ({
	startProvider: (...args: unknown[]) => startProvider(...args),
}));

import { noopMonitor } from "@onlooker/monitoring";
import { createRecordingMonitor } from "@onlooker/monitoring/testing";
import {
	clientErrorMonitor,
	createDeferredMonitor,
	initMonitoring,
	installGlobalErrorCapture,
} from "../monitoring";

function lastReport() {
	const { calls } = reportClientError.mock;
	return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe("clientErrorMonitor", () => {
	beforeEach(() => {
		reportClientError.mockClear();
	});

	it("carries a render error's kind and component stack to the reporter", () => {
		const error = new Error("deliberate");

		clientErrorMonitor.captureException(error, {
			tags: { kind: "render" },
			extra: { componentStack: "\n    at LessonsPage" },
		});

		expect(lastReport()).toMatchObject({
			kind: "render",
			message: "deliberate",
			stack: error.stack,
			componentStack: "\n    at LessonsPage",
		});
	});

	it("reports a thrown non-Error by its string, as an uncaught error", () => {
		clientErrorMonitor.captureException("just a string");

		expect(lastReport()).toMatchObject({
			kind: "uncaught",
			message: "just a string",
		});
	});

	// The reporter's `kind` is a closed set the API validates on receipt. A tag
	// outside it must not become a report the API drops.
	it("falls back to uncaught for a kind the reporter does not know", () => {
		clientErrorMonitor.captureException(new Error("x"), {
			tags: { kind: "surprise" },
		});

		expect(lastReport()?.kind).toBe("uncaught");
	});
});

// The provider arrives in its own chunk after the app is running, so the
// monitor App holds from the first render is a stand-in until then.
describe("createDeferredMonitor", () => {
	it("drops what is said before the provider arrives", () => {
		const deferred = createDeferredMonitor();
		const provider = createRecordingMonitor();

		deferred.monitor.captureException(new Error("too early"));
		deferred.attach(provider.monitor);

		expect(provider.exceptions).toEqual([]);
	});

	it("forwards everything once the provider arrives", () => {
		const deferred = createDeferredMonitor();
		const provider = createRecordingMonitor();
		const error = new Error("after load");

		deferred.attach(provider.monitor);
		deferred.monitor.captureException(error);
		deferred.monitor.count("lessons.viewed");

		expect(provider.exceptions.map((e) => e.error)).toEqual([error]);
		expect(provider.counts.map((c) => c.name)).toEqual(["lessons.viewed"]);
	});

	// A restored session sets the user on first render, long before the chunk
	// loads. Dropping that one would leave every later event anonymous.
	it("hands the provider the user who signed in before it arrived", () => {
		const deferred = createDeferredMonitor();
		const provider = createRecordingMonitor();

		deferred.monitor.setUser({ id: "u1" });
		deferred.attach(provider.monitor);

		expect(provider.users).toEqual([{ id: "u1" }]);
	});

	it("still runs span work before the provider arrives", () => {
		const deferred = createDeferredMonitor();

		expect(deferred.monitor.startSpan({ name: "s", op: "o" }, () => 7)).toBe(7);
	});
});

describe("installGlobalErrorCapture", () => {
	beforeEach(() => {
		reportClientError.mockClear();
	});

	it("reports an unhandled rejection once", () => {
		const target = new EventTarget() as unknown as Window;
		installGlobalErrorCapture(target);

		const event = Object.assign(new Event("unhandledrejection"), {
			reason: new Error("lost promise"),
		});
		target.dispatchEvent(event);

		expect(reportClientError).toHaveBeenCalledTimes(1);
		expect(lastReport()).toMatchObject({
			kind: "unhandled-rejection",
			message: "lost promise",
		});
	});

	it("reports an error thrown outside React", () => {
		const target = new EventTarget() as unknown as Window;
		installGlobalErrorCapture(target);

		const event = Object.assign(new Event("error"), {
			error: new Error("listener threw"),
		});
		target.dispatchEvent(event);

		expect(reportClientError).toHaveBeenCalledTimes(1);
		expect(lastReport()).toMatchObject({
			kind: "uncaught",
			message: "listener threw",
		});
	});
});

/**
 * The one place the build's own facts are read.
 *
 * A typo in either variable name is invisible to the compiler - ImportMetaEnv
 * carries an index signature, so `VITE_MONITORNIG_RELEASE` type-checks and
 * arrives undefined - and invisible at runtime too, since a missing release
 * costs nothing but the release.
 */
describe("initMonitoring", () => {
	beforeEach(() => {
		startProvider.mockClear();
		vi.unstubAllEnvs();
	});

	function providerConfig(): Record<string, unknown> {
		return startProvider.mock.calls[0]?.[0] as Record<string, unknown>;
	}

	it("hands the provider the commit the bundle was built from", async () => {
		vi.stubEnv("VITE_MONITORING_DSN", "https://k@o1.ingest.sentry.io/1");
		vi.stubEnv("VITE_MONITORING_RELEASE", "0f1e2d3c4b5a");

		initMonitoring();

		await vi.waitFor(() => expect(startProvider).toHaveBeenCalledTimes(1));
		expect(providerConfig().release).toBe("0f1e2d3c4b5a");
	});

	// A local build has no commit to claim, and the provider still has to start
	// - the DSN is what decides whether monitoring runs, not the release.
	it("starts the provider anyway when the build supplied no commit", async () => {
		vi.stubEnv("VITE_MONITORING_DSN", "https://k@o1.ingest.sentry.io/1");
		vi.stubEnv("VITE_MONITORING_RELEASE", "");

		initMonitoring();

		await vi.waitFor(() => expect(startProvider).toHaveBeenCalledTimes(1));
		expect(providerConfig().release).toBeUndefined();
	});
});
