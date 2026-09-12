import { describe, expect, it } from "vitest";
import { satisfies } from "../ranges";

describe("satisfies", () => {
	it("evaluates a single upper bound", () => {
		expect(satisfies("5.2.1", "<6")).toBe("satisfied");
		expect(satisfies("6.0.0", "<6")).toBe("unsatisfied");
	});

	it("evaluates a single lower bound", () => {
		expect(satisfies("5.2.1", ">=4")).toBe("satisfied");
		expect(satisfies("3.9.9", ">=4")).toBe("unsatisfied");
	});

	// Two clauses AND, lower bound then upper, per VERSION_RANGE.
	it("evaluates a two-sided range", () => {
		expect(satisfies("5.2.1", ">=4 <6")).toBe("satisfied");
		expect(satisfies("3.0.0", ">=4 <6")).toBe("unsatisfied");
		expect(satisfies("6.0.1", ">=4 <6")).toBe("unsatisfied");
	});

	// The bug a string comparison produces: "10" sorts before "9" as text, so
	// a lesson scoped >=9 would exclude every 10.x.
	it("compares numerically, not lexically", () => {
		expect(satisfies("10.0.0", ">=9")).toBe("satisfied");
		expect(satisfies("5.10.0", ">=5.9")).toBe("satisfied");
	});

	it("treats a missing component as zero", () => {
		expect(satisfies("6", "<6.0.1")).toBe("satisfied");
		expect(satisfies("6.0", ">=6")).toBe("satisfied");
	});

	// Someone on a 6 prerelease is on 6 for a lesson scoped <6. The other
	// reading keeps a retired lesson alive for exactly the people most likely
	// to hit whatever replaced it.
	it("compares a prerelease on its numeric core", () => {
		expect(satisfies("6.0.0-beta.1", "<6")).toBe("unsatisfied");
		expect(satisfies("6.0.0-beta.1", ">=6")).toBe("satisfied");
	});

	it("reports an unparseable installed version rather than guessing", () => {
		expect(satisfies("workspace:*", "<6")).toBe("unparseable");
		expect(satisfies("", "<6")).toBe("unparseable");
	});

	// A bare "4" is rejected by the contract precisely because it is ambiguous
	// between "exactly 4" and "4 and above". If one reaches us anyway,
	// inventing a meaning would hide that something upstream accepted what it
	// should not have.
	it("reports an unparseable range rather than guessing", () => {
		expect(satisfies("4.0.0", "4")).toBe("unparseable");
		expect(satisfies("4.0.0", "~4")).toBe("unparseable");
		expect(satisfies("4.0.0", "")).toBe("unparseable");
	});

	it("evaluates every clause, not just the first", () => {
		// Passes the lower bound and fails the upper: a matcher that returned
		// on the first satisfied clause would call this applicable.
		expect(satisfies("9.0.0", ">=4 <6")).toBe("unsatisfied");
	});
});
