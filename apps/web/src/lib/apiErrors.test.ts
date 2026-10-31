import { AuthApiError } from "@onlooker/auth-react";
import { describe, expect, it } from "vitest";
import { describeError, describeRefusal } from "./apiErrors";

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

// The mail cap answers 429 with a message that says why and when; anything
// else on a send keeps the generic line rather than leaking a raw failure.
describe("describeRefusal", () => {
	it("shows the server's message for a 429", () => {
		const capped = new AuthApiError(
			429,
			"rate_limit_exceeded",
			"Too many emails to this address. Try again later.",
		);

		expect(describeRefusal(capped, "Could not send")).toBe(
			"Too many emails to this address. Try again later.",
		);
	});

	it("falls back for any other failure", () => {
		expect(
			describeRefusal(
				new AuthApiError(500, "internal_error", "boom"),
				"Could not send",
			),
		).toBe("Could not send");
		expect(describeRefusal(new Error("network"), "Could not send")).toBe(
			"Could not send",
		);
	});
});
