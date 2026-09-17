import { describe, expect, it } from "vitest";
import { sectionFor } from "../components/sections";

// Pure path logic, no render: this is the rule AppShell uses to pick the h1
// and titles.ts uses to pick the document title, so it is worth pinning on
// its own rather than only through whatever a page happens to render.
describe("sectionFor", () => {
	it("matches a section exactly", () => {
		expect(sectionFor("/lessons")?.label).toBe("Lessons");
	});

	// The reason /lessons/:id shows "Lessons" rather than no heading at all.
	it("matches a child of a section", () => {
		expect(sectionFor("/lessons/01J8Z4K2M3N4P5Q6R7S8T9V0W1")?.label).toBe(
			"Lessons",
		);
	});

	// The slash in the prefix is load-bearing and this is what proves it.
	// Without it a future /lessons-archive would render under the Lessons
	// heading and mark the Lessons nav link as the current page.
	it("does not match a sibling that merely shares a prefix", () => {
		expect(sectionFor("/lessons-archive")).toBeUndefined();
	});

	it("returns undefined for a path in no section", () => {
		expect(sectionFor("/login")).toBeUndefined();
	});
});
