import { describe, expect, it } from "vitest";
import { ZAppliesTo } from "./applies-to.js";

const valid = {
	stack: ["vitest", "vite"],
	scope: { kind: "versioned", versions: { vite: "<6", vitest: ">=4" } },
	file_patterns: ["**/vite.config.*", "**/package.json"],
	task_kinds: ["test-setup", "ci"],
};

const withVersions = (versions: Record<string, string>) => ({
	...valid,
	scope: { kind: "versioned", versions },
});

describe("ZAppliesTo", () => {
	it("accepts the stale vitest lesson's applicability", () => {
		expect(ZAppliesTo.parse(valid)).toEqual(valid);
	});

	it("accepts a two-sided range", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: ">=4 <6" })).success).toBe(
			true,
		);
	});

	it("accepts a full three-part version", () => {
		expect(
			ZAppliesTo.safeParse(withVersions({ vite: ">=4.1.2" })).success,
		).toBe(true);
	});

	it("rejects a range with no comparator", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "4" })).success).toBe(
			false,
		);
	});

	it("rejects free text where a range belongs", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "potato" })).success).toBe(
			false,
		);
	});

	it("rejects two bounds facing the same direction", () => {
		for (const range of [">4 >6", "<4 <2"]) {
			expect(ZAppliesTo.safeParse(withVersions({ vite: range })).success).toBe(
				false,
			);
		}
	});

	it("rejects an exact match carrying a second bound", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: "=4 <6" })).success).toBe(
			false,
		);
	});

	// A vacuous lower bound matches every session forever and never faces
	// the version_independent justification gate.
	it("rejects vacuous single-sided lower bounds", () => {
		for (const range of [">=0", ">=0.0", ">=0.0.0", ">0"]) {
			expect(ZAppliesTo.safeParse(withVersions({ vite: range })).success).toBe(
				false,
			);
		}
	});

	it("accepts non-zero pre-1.0 lower bounds", () => {
		for (const range of [">=0.5", ">0.9.1"]) {
			expect(ZAppliesTo.safeParse(withVersions({ vite: range })).success).toBe(
				true,
			);
		}
	});

	it("accepts a zero lower bound once an upper bound makes it finite", () => {
		expect(ZAppliesTo.safeParse(withVersions({ vite: ">=0 <6" })).success).toBe(
			true,
		);
	});

	it("requires at least one stack entry so a lesson cannot match everything", () => {
		expect(ZAppliesTo.safeParse({ ...valid, stack: [] }).success).toBe(false);
	});

	// The heart of onlooker-7jn. An empty map used to be legal and meant both
	// "no version dependency" and "inference failed", so a failed transform
	// silently produced a lesson that never expires.
	it("rejects an empty versions map, which could never expire", () => {
		expect(ZAppliesTo.safeParse(withVersions({})).success).toBe(false);
	});

	it("accepts a version-independent lesson that justifies itself", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: {
					kind: "version_independent",
					justification:
						"The --frozen-lockfile flag has meant the same thing in every " +
						"pnpm major, so no version bound applies.",
				},
			}).success,
		).toBe(true);
	});

	it("rejects version_independent with no justification, so a failed inference cannot land here", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: { kind: "version_independent" },
			}).success,
		).toBe(false);
	});

	it("rejects an empty justification", () => {
		expect(
			ZAppliesTo.safeParse({
				...valid,
				scope: { kind: "version_independent", justification: "" },
			}).success,
		).toBe(false);
	});

	it("rejects an unknown scope kind", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, scope: { kind: "whenever" } }).success,
		).toBe(false);
	});

	it("rejects the v1 shape that put versions at the top level", () => {
		const { scope, ...withoutScope } = valid;
		expect(
			ZAppliesTo.safeParse({ ...withoutScope, versions: { vite: "<6" } })
				.success,
		).toBe(false);
	});
});
