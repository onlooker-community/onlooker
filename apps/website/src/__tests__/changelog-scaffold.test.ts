import { describe, expect, it } from "vitest";
import { sectionProblems } from "../lib/changelog-entries";
import { scaffold, weekOf } from "../lib/changelog-scaffold";

describe("weekOf", () => {
	// Weeks run Saturday to Friday, named for the Friday.
	it("starts a week on a Saturday", () => {
		expect(weekOf("2026-11-21")).toEqual({
			weekStart: "2026-11-21",
			weekEnd: "2026-11-27",
		});
	});

	it("puts a Friday at the end of its own week", () => {
		expect(weekOf("2026-11-20")).toEqual({
			weekStart: "2026-11-14",
			weekEnd: "2026-11-20",
		});
	});

	it("crosses a month", () => {
		expect(weekOf("2026-12-02")).toEqual({
			weekStart: "2026-11-28",
			weekEnd: "2026-12-04",
		});
	});

	it("refuses a date it can't read", () => {
		expect(() => weekOf("2026-13-01")).toThrow(/YYYY-MM-DD/);
		expect(() => weekOf("Nov 21")).toThrow(/YYYY-MM-DD/);
	});
});

describe("scaffold", () => {
	const week = { weekStart: "2026-11-21", weekEnd: "2026-11-27" };
	const file = scaffold(week);
	const body = file.split("\n---\n")[1];

	it("fills the frontmatter as a draft", () => {
		expect(file.startsWith("---\n")).toBe(true);
		expect(file).toContain('title: "Draft: November 21 to 27, 2026"');
		expect(file).toContain("weekStart: 2026-11-21\n");
		expect(file).toContain("weekEnd: 2026-11-27\n");
		expect(file).toContain("draft: true\n");
	});

	it("lays out every section but Hosted feed, in order", () => {
		const headings = body.split("\n").filter((l) => l.startsWith("## "));
		expect(headings).toEqual([
			"## Plugins",
			"## onlooker.dev",
			"## Reliability",
			"## Behind the scenes",
		]);
	});

	// A draft builds with its empty sections; publishing one fails until each
	// is written or deleted.
	it("passes as a draft and fails as a published entry", () => {
		expect(sectionProblems(body, true)).toEqual([]);
		expect(sectionProblems(body, false)).toHaveLength(4);
	});
});
