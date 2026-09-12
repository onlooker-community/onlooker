import { beforeEach, describe, expect, it, vi } from "vitest";

// The Workers Logs path is the one client-error-monitor.yml alerts on, so it is
// the one these follow. The provider half of the fanout has no client in tests
// and sends nothing.
const reportClientError = vi.fn();
vi.mock("../lib/reportError", () => ({
	reportClientError: (...args: unknown[]) => reportClientError(...args),
}));

import { clientErrorMonitor, installGlobalErrorCapture } from "../monitoring";

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
