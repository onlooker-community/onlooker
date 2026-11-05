import { AuthApiError } from "@onlooker/auth-core";
import { describe, expect, it } from "vitest";
import {
	isSessionGone,
	parseRetryAfter,
	RETRY_BACKOFF_MS,
	retryDelayMs,
} from "./transient";

describe("isSessionGone", () => {
	it("is true only for a 401", () => {
		expect(isSessionGone(new AuthApiError(401, "unauthorized", "x"))).toBe(
			true,
		);
		for (const status of [400, 403, 429, 500, 503]) {
			expect(isSessionGone(new AuthApiError(status, "x", "x"))).toBe(false);
		}
	});

	it("treats a thrown non-API error as transient", () => {
		expect(isSessionGone(new TypeError("Failed to fetch"))).toBe(false);
		expect(isSessionGone(new Error("Session refresh failed"))).toBe(false);
		expect(isSessionGone(undefined)).toBe(false);
	});
});

describe("retryDelayMs", () => {
	it("uses the server's Retry-After when the error carries one", () => {
		const error = new AuthApiError(429, "rate_limited", "x", undefined, 30_000);
		expect(retryDelayMs(error, 0)).toBe(30_000);
		expect(retryDelayMs(error, 4)).toBe(30_000);
	});

	it("raises a zero Retry-After to a second", () => {
		const error = new AuthApiError(429, "rate_limited", "x", undefined, 0);
		expect(retryDelayMs(error, 0)).toBe(1_000);
	});

	it("caps a Retry-After past setTimeout's range at an hour", () => {
		const error = new AuthApiError(
			429,
			"rate_limited",
			"x",
			undefined,
			2 ** 31,
		);
		expect(retryDelayMs(error, 0)).toBe(3_600_000);
	});

	it("leaves a Retry-After inside the bounds alone", () => {
		const error = new AuthApiError(429, "rate_limited", "x", undefined, 30_000);
		expect(retryDelayMs(error, 0)).toBe(30_000);
	});

	it("backs off 5, 10, 20, 40, then 60 seconds, capped", () => {
		const error = new TypeError("Failed to fetch");
		expect([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(error, n))).toEqual([
			5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
		expect(RETRY_BACKOFF_MS).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
	});
});

describe("parseRetryAfter", () => {
	it("reads delta-seconds", () => {
		expect(parseRetryAfter("60", 0)).toBe(60_000);
		expect(parseRetryAfter(" 2 ", 0)).toBe(2_000);
	});

	it("reads an HTTP date relative to now", () => {
		const now = Date.parse("2026-11-03T12:00:00Z");
		expect(parseRetryAfter("Tue, 03 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
	});

	it("never answers a negative wait for a date already past", () => {
		const now = Date.parse("2026-11-03T12:00:00Z");
		expect(parseRetryAfter("Tue, 03 Nov 2026 11:00:00 GMT", now)).toBe(0);
	});

	it("is undefined for a missing, empty or unreadable header", () => {
		expect(parseRetryAfter(null, 0)).toBeUndefined();
		expect(parseRetryAfter("", 0)).toBeUndefined();
		expect(parseRetryAfter("soon", 0)).toBeUndefined();
	});

	// ONL-247. RFC 9110 delta-seconds is digits only. `Number()` read all of
	// these, and V8's Date.parse reads "1.5" and "-5" as dates in 2001 - a
	// wait of zero - so each has to fail both readings.
	it.each([
		"1.5",
		"0x10",
		"1e3",
		"-5",
		"+5",
	])("is undefined for %s", (header) => {
		expect(
			parseRetryAfter(header, Date.parse("2026-11-03T12:00:00Z")),
		).toBeUndefined();
	});
});
