import { describe, expect, it } from "vitest";
import { declared, stylesheets } from "./stylesheets";

// Abaddon is a pixel face with a 16px design size. packages/brand says it
// renders cleanly only at integer multiples of that, and anything between
// "turns the art to mush". On 2026-11-08 every rule on the site that used it
// broke that: clamp() ranges on every page title, 22px list titles, and
// article headings at sizes inherited from the body text. An em
// letter-spacing does the same damage at a legal size, by moving every glyph
// off the pixel grid.
//
// This reads every stylesheet the site has, the global one and each .astro
// file's <style> blocks, so a new heading cannot opt out by living in a page.

const DISPLAY = /font-family:\s*var\(--(?:font-)?display\)/;

const display = stylesheets.flatMap(({ name, rules }) =>
	rules
		.filter((r) => DISPLAY.test(r.body))
		.map((r) => ({ name, rule: r, all: rules })),
);

describe("the pixel face (Abaddon)", () => {
	// Four rules use it once this lands: the landing headline, the two plugin
	// page titles, and the blog's shared page-title rule. Fewer found means the
	// parser stopped seeing them, not that they were fixed.
	it("is found where the site uses it", () => {
		expect(display.length).toBeGreaterThanOrEqual(4);
	});

	for (const { name, rule, all } of display) {
		const label = `${name}: ${rule.selector}`;

		it(`${label} sets its own size, a multiple of 16px, at every breakpoint`, () => {
			expect(
				declared(rule.body, "font-size"),
				`${label} inherits its size`,
			).toBeDefined();

			const sizes = all
				.filter((r) => r.selector === rule.selector)
				.map((r) => declared(r.body, "font-size"))
				.filter((size): size is string => size !== undefined);

			for (const size of sizes) {
				const px = /^(\d+)px$/.exec(size);
				expect(px, `${label} has font-size ${size}`).not.toBeNull();
				expect(Number(px?.[1]) % 16, `${label} has font-size ${size}`).toBe(0);
			}
		});

		it(`${label} keeps glyphs on the pixel grid`, () => {
			expect(declared(rule.body, "letter-spacing") ?? "0").toBe("0");
		});

		// The face ships 400 and 700. Anything else is synthesized by the
		// browser, which smears the pixels the way an off-grid size does.
		it(`${label} uses a weight the face ships`, () => {
			expect(declared(rule.body, "font-weight")).toBe("700");
		});
	}
});
