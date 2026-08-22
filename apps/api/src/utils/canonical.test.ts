import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.js";

describe("canonicalize", () => {
	// The reason this exists. A mirror re-pushing a lesson it pulled will
	// legitimately produce different key ordering, and comparing raw strings
	// would turn every re-push into a spurious 409.
	it("gives the same output regardless of key order", () => {
		expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
	});

	it("sorts nested objects too", () => {
		expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
			canonicalize({ outer: { a: 2, z: 1 } }),
		);
	});

	// Array order is semantic - applies_to.stack is a list, not a set - so
	// reordering it is a different lesson, not the same one written differently.
	it("preserves array order", () => {
		expect(canonicalize(["b", "a"])).not.toBe(canonicalize(["a", "b"]));
	});

	it("distinguishes null from absent", () => {
		expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
	});

	it("handles the primitives", () => {
		expect(canonicalize(1)).toBe("1");
		expect(canonicalize("x")).toBe('"x"');
		expect(canonicalize(true)).toBe("true");
		expect(canonicalize(null)).toBe("null");
	});
});
