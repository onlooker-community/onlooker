import { describe, expect, it } from "vitest";
import { describeError } from "./apiErrors";

// The 501 case is the whole reason this module exists: every account endpoint
// is a stub in apps/api and fully working in the mock, so these features
// succeed in development and answer 501 in production. Without this the user
// sees "Request failed with status 501" and has no way to tell a missing
// feature from a broken one.
function apiError(status: number, message = "Request failed") {
	return Object.assign(new Error(message), { status });
}

describe("describeError", () => {
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
