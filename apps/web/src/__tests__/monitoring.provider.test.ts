import { describe, expect, it } from "vitest";
import { routeName } from "../monitoring.provider";

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
