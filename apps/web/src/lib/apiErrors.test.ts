import { describe, expect, it } from "vitest";
import { describeError, isNotImplemented } from "./apiErrors";

// The 501 case is the whole reason this module exists: every account endpoint
// is a stub in apps/api and fully working in the mock, so these features
// succeed in development and answer 501 in production. Without this the user
// sees "Request failed with status 501" and has no way to tell a missing
// feature from a broken one.
function apiError(status: number, message = "Request failed") {
	return Object.assign(new Error(message), { status });
}

describe("isNotImplemented", () => {
	it("recognizes a 501", () => {
		expect(isNotImplemented(apiError(501))).toBe(true);
	});

	it("leaves other failures alone", () => {
		for (const status of [400, 401, 404, 409, 500, 503]) {
			expect(isNotImplemented(apiError(status))).toBe(false);
		}
	});

	it("survives things that are not errors at all", () => {
		for (const value of [null, undefined, "boom", 501, {}, new Error("x")]) {
			expect(isNotImplemented(value)).toBe(false);
		}
	});
});

describe("describeError", () => {
	it("says a 501 is unbuilt rather than broken", () => {
		const message = describeError(apiError(501), "fallback");

		expect(message).toMatch(/isn't available yet/i);
		// The status must not leak - "501" reads as a bug the user caused.
		expect(message).not.toMatch(/501/);
	});

	it("passes through a real failure's own message", () => {
		expect(describeError(apiError(401, "Invalid email or password"), "x")).toBe(
			"Invalid email or password",
		);
	});

	it("falls back when there is no message to show", () => {
		expect(describeError("not an error", "Could not save")).toBe(
			"Could not save",
		);
	});
});
