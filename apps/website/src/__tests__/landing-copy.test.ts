import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// index.astro reads astro:content, which configFile: false leaves
// unresolved, so it cannot render here. Its claims are literal text in the
// source, which is what this checks.
const page = readFileSync(
	new URL("../pages/index.astro", import.meta.url),
	"utf8",
);

// ONL-267: each of these named something that did not ship, or a count
// that had already gone stale. Putting one back should fail this test.
describe("the landing page", () => {
	for (const retired of [
		"Waypoint",
		"Playbook",
		"13+",
		"smarter than the last",
		"Learn from every failure",
		"Everything stays on your machine",
	]) {
		it(`no longer claims "${retired}"`, () => {
			expect(page).not.toContain(retired);
		});
	}

	it("points at the plugins' source", () => {
		expect(page).toContain(
			'href="https://github.com/onlooker-community/ecosystem"',
		);
	});

	it("links the license it claims", () => {
		expect(page).toContain(
			'href="https://github.com/onlooker-community/ecosystem/blob/main/LICENSE"',
		);
	});

	it("still posts the waitlist to the same endpoint", () => {
		expect(page).toContain("https://formsubmit.co/ajax/early@onlooker.dev");
	});

	it("shows the blog's latest post", () => {
		expect(page).toMatch(/<LatestPost post=\{posts\[0\]\} \/>/);
	});
});
