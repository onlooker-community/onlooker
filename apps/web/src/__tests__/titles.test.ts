import { describe, expect, it } from "vitest";
import { titleFor } from "../titles";

describe("titleFor", () => {
	// Section first, product second: a tab strip truncates from the right, so
	// the half worth keeping goes on the left.
	it("names the section before the product", () => {
		expect(titleFor("/machines")).toBe("Machines · Onlooker");
	});

	it("titles a lesson under its section", () => {
		expect(titleFor("/lessons/01J8Z4K2M3N4P5Q6R7S8T9V0W1")).toBe(
			"Lessons · Onlooker",
		);
	});

	it("titles a route that has no section", () => {
		expect(titleFor("/login")).toBe("Sign in · Onlooker");
	});

	// The token-carrying routes are the reason this matches by prefix rather
	// than by equality.
	it("titles a parameterized route outside the shell", () => {
		expect(titleFor(`/reset-password/${"a".repeat(64)}`)).toBe(
			"Choose a new password · Onlooker",
		);
	});

	// Anything not listed renders the catch-all route, so the fallback is the
	// not-found title. scripts/source-guards.test.sh is what keeps that from
	// mislabeling a real route somebody forgot to list.
	it("falls back to the not-found title", () => {
		expect(titleFor("/nothing-here")).toBe("Page not found · Onlooker");
	});
});
