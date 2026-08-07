import { describe, expect, it } from "vitest";
import { ZAppliesTo } from "./applies-to.js";

const valid = {
	stack: ["vitest", "vite"],
	versions: { vite: "<6", vitest: ">=4" },
	file_patterns: ["**/vite.config.*", "**/package.json"],
	task_kinds: ["test-setup", "ci"],
};

describe("ZAppliesTo", () => {
	it("accepts the stale vitest lesson's applicability", () => {
		expect(ZAppliesTo.parse(valid)).toEqual(valid);
	});

	it("accepts a two-sided range", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: ">=4 <6" } }).success,
		).toBe(true);
	});

	it("accepts a full three-part version", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: ">=4.1.2" } }).success,
		).toBe(true);
	});

	it("rejects a range with no comparator", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: "4" } }).success,
		).toBe(false);
	});

	it("rejects free text where a range belongs", () => {
		expect(
			ZAppliesTo.safeParse({ ...valid, versions: { vite: "potato" } }).success,
		).toBe(false);
	});

	it("requires at least one stack entry so a lesson cannot match everything", () => {
		expect(ZAppliesTo.safeParse({ ...valid, stack: [] }).success).toBe(false);
	});

	it("allows an empty versions map for version-independent lessons", () => {
		expect(ZAppliesTo.safeParse({ ...valid, versions: {} }).success).toBe(true);
	});
});
