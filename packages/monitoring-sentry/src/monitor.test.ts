import * as Sentry from "@sentry/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSentryMonitor } from "./monitor";

vi.mock("@sentry/core", () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	setUser: vi.fn(),
	flush: vi.fn(async () => true),
	startSpan: vi.fn((_options: unknown, callback: () => unknown) => callback()),
	metrics: { count: vi.fn() },
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("createSentryMonitor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sends only the user's id, whatever else the caller passed", () => {
		const user = { id: "u1", email: "someone@example.com" };

		createSentryMonitor().setUser(user);

		expect(Sentry.setUser).toHaveBeenCalledWith({ id: "u1" });
	});

	it("translates warn into Sentry's severity name", () => {
		createSentryMonitor().captureMessage("slow", "warn", {
			tags: { surface: "api" },
		});

		expect(Sentry.captureMessage).toHaveBeenCalledWith("slow", {
			tags: { surface: "api" },
			level: "warning",
		});
	});

	it("passes counts and their attributes through", () => {
		createSentryMonitor().count("waitlist.viewed", 1, { looks_valid: true });

		expect(Sentry.metrics.count).toHaveBeenCalledWith("waitlist.viewed", 1, {
			attributes: { looks_valid: true },
		});
	});

	it("runs span work and returns its value", () => {
		const result = createSentryMonitor().startSpan(
			{ name: "submit", op: "http.client" },
			() => "ok",
		);

		expect(result).toBe("ok");
		expect(Sentry.startSpan).toHaveBeenCalledOnce();
	});

	it("does not throw when the SDK does", () => {
		vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
			throw new Error("sdk broke");
		});

		expect(() =>
			createSentryMonitor().captureException(new Error("x")),
		).not.toThrow();
	});
});
