import { describe, expect, it } from "vitest";
import {
	expectArray,
	expectObject,
	expectString,
	shapeFailures,
} from "./index";

const ERROR_BODY = { error: { code: "bad_request", message: "nope" } };

describe("shapeFailures", () => {
	it("passes a body that satisfies a nested expectation", () => {
		expect(
			shapeFailures(ERROR_BODY, { error: { code: expectString } }),
		).toEqual([]);
	});

	// The bug this file exists for. Before the fix, `error: expectObject` was the
	// only expressible error assertion, and it says nothing about the contents -
	// so renaming `code` passed the whole suite.
	it("catches a renamed key inside a nested object", () => {
		const failures = shapeFailures(
			{ error: { kode: "bad_request" } },
			{ error: { code: expectString } },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("error.code");
	});

	it("catches a nested key whose value is the wrong type", () => {
		const failures = shapeFailures(
			{ error: { code: 42 } },
			{ error: { code: expectString } },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("error.code");
	});

	// Path qualification is not cosmetic: the same key name can now appear at
	// two depths, and `"code" should be a non-empty string` does not say which.
	it("names the full path in a nested failure, not just the key", () => {
		const failures = shapeFailures(
			{ error: {} },
			{ error: { code: expectString } },
		);
		expect(failures[0]).toContain("error.code");
		expect(failures[0]).not.toBe('missing "code"');
	});

	it("pins a nested value exactly when given a literal", () => {
		expect(
			shapeFailures(ERROR_BODY, { error: { code: "bad_request" } }),
		).toEqual([]);
		expect(
			shapeFailures(ERROR_BODY, { error: { code: "something_else" } }),
		).toHaveLength(1);
	});

	// Subset at every depth, matching the top level. An API adding a field to an
	// error envelope breaks no client.
	it("allows extra keys inside a nested object", () => {
		expect(
			shapeFailures(ERROR_BODY, { error: { code: expectString } }),
		).toEqual([]);
	});

	it("recurses more than one level", () => {
		expect(
			shapeFailures(
				{ a: { b: { c: "deep" } } },
				{ a: { b: { c: expectString } } },
			),
		).toEqual([]);
		expect(
			shapeFailures({ a: { b: { c: 1 } } }, { a: { b: { c: expectString } } }),
		).toHaveLength(1);
	});

	// The same trap the nested-object fix removed, surviving one type over.
	// An array expectation fell through to `got === want`, a reference
	// comparison against a fresh literal, which is always false - so an array
	// expectation could not be written, nobody wrote one, and array contents
	// went unasserted. Latent only because no case used one, which is exactly
	// how the object version stayed hidden.
	it("passes an array expectation whose elements match", () => {
		expect(shapeFailures({ xs: [1, 2] }, { xs: [1, 2] })).toEqual([]);
	});

	it("catches an element whose value differs", () => {
		const failures = shapeFailures({ xs: [1, 2] }, { xs: [1, 3] });
		expect(failures).toEqual(['"xs[1]" should be 3, got number']);
	});

	it("recurses into an object inside an array", () => {
		expect(
			shapeFailures({ xs: [{ a: "s" }] }, { xs: [{ a: expectString }] }),
		).toEqual([]);
		expect(
			shapeFailures({ xs: [{ a: 1 }] }, { xs: [{ a: expectString }] }),
		).toEqual(['"xs[0].a" should be a non-empty string, got number']);
	});

	// Length is part of an array expectation in a way extra keys are not part
	// of an object one: an object's extra keys are the fields a real response
	// carries beyond what a case pins, while an array's extra element is a
	// different answer at a position the expectation named.
	it("reports a length mismatch rather than comparing what overlaps", () => {
		const failures = shapeFailures({ xs: [1, 2, 3] }, { xs: [1, 2] });
		expect(failures).toEqual(['"xs" should have 2 elements, got 3']);
	});

	it("reports an array expectation against a non-array", () => {
		expect(shapeFailures({ xs: "nope" }, { xs: [1] })).toEqual([
			'"xs" should be an array, got string',
		]);
	});

	it("recurses into an array nested inside an object", () => {
		expect(
			shapeFailures(
				{ error: { codes: ["a", "b"] } },
				{ error: { codes: [expectString, expectString] } },
			),
		).toEqual([]);
	});

	it("reports a nested expectation against a non-object", () => {
		const failures = shapeFailures(
			{ error: "a string" },
			{ error: { code: expectString } },
		);
		// The whole message, not a substring. The old reference comparison also
		// produced one failure mentioning "error" - `"error" should be [object
		// Object], got string` - so a `toContain("error")` here agreed with both
		// implementations and proved nothing. What distinguishes them is the claim
		// being made: that `error` is not an object at all, reported at its path.
		expect(failures).toEqual(["error is string, not an object"]);
	});

	// The three symbols must keep working, at both depths.
	it("keeps the symbols working at the top level", () => {
		expect(
			shapeFailures(
				{ o: {}, a: [], s: "x" },
				{ o: expectObject, a: expectArray, s: expectString },
			),
		).toEqual([]);
	});

	it("supports the symbols inside a nested object", () => {
		expect(
			shapeFailures(
				{ w: { o: {}, a: [], s: "x" } },
				{ w: { o: expectObject, a: expectArray, s: expectString } },
			),
		).toEqual([]);
	});

	it("still compares a non-object expectation by equality", () => {
		expect(shapeFailures({ n: 1 }, { n: 1 })).toEqual([]);
		expect(shapeFailures({ n: 1 }, { n: 2 })).toHaveLength(1);
	});

	it("still reports a missing top-level key", () => {
		expect(shapeFailures({}, { error: expectObject })).toEqual([
			'missing "error"',
		]);
	});
});
