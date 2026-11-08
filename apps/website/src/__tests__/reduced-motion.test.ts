import { describe, expect, it } from "vitest";
import { declared, stylesheets } from "./stylesheets";

// On 2026-11-08 six blocks on the landing page started at opacity: 0 and
// relied on the fade-up animation to show them. Anything that stopped the
// animation from running, a reduced-motion rule included, left them
// invisible. Each block now rests visible and is hidden through its delay by
// fade-up's first keyframe instead, which takes `both` (or `backwards`)
// fill. With `forwards` and no opacity: 0, the block would show during its
// delay, vanish, and then fade in.

const animated = stylesheets.flatMap(({ name, rules }) =>
	rules
		.filter((rule) => declared(rule.body, "animation") !== undefined)
		.map((rule) => ({ label: `${name}: ${rule.selector}`, rule })),
);

const fadeUp = animated.filter(({ rule }) =>
	/\bfade-up\b/.test(declared(rule.body, "animation") ?? ""),
);

describe("animated blocks", () => {
	// Six use fade-up today: five on the landing page and the latest-post
	// line. Fewer found means the parser stopped seeing them.
	it("are found where the site uses them", () => {
		expect(fadeUp.length).toBeGreaterThanOrEqual(6);
	});

	for (const { label, rule } of animated) {
		it(`${label} rests visible`, () => {
			expect(declared(rule.body, "opacity")).not.toBe("0");
		});
	}

	for (const { label, rule } of fadeUp) {
		it(`${label} is hidden through its delay by the animation`, () => {
			expect(declared(rule.body, "animation")).toMatch(/\b(both|backwards)\b/);
		});
	}
});

// A reader who asks for less motion gets none. The rule is global, so a new
// animated block is covered without anyone remembering it. ::before and
// ::after are named because the pulsing logo ring and the radar sweep are
// both ::after.
describe("prefers-reduced-motion: reduce", () => {
	const reduceRules =
		stylesheets
			.find(({ name }) => name === "styles/globals.css")
			?.rules.filter((rule) =>
				/prefers-reduced-motion:\s*reduce/.test(rule.media ?? ""),
			) ?? [];
	const reduce = reduceRules.find((rule) =>
		rule.selector.split(",").some((s) => s.trim() === "*"),
	);

	it("turns animation off for every element and pseudo-element", () => {
		expect(reduce, "globals.css has no reduced-motion rule").toBeDefined();
		expect(reduce?.selector.split(",").map((s) => s.trim())).toEqual(
			expect.arrayContaining(["*", "*::before", "*::after"]),
		);
		expect(declared(reduce?.body ?? "", "animation")).toBe("none !important");
	});

	// Stopped at its resting style the logo's ring would be at full opacity,
	// brighter than it ever is while pulsing (0.8 fading to 0).
	it("holds the logo's pulse ring at about its average brightness", () => {
		const ring = reduceRules.find(
			(rule) => rule.selector === ".logo-pulse::after",
		);
		expect(ring, "no reduced-motion rule for .logo-pulse::after").toBeDefined();
		expect(declared(ring?.body ?? "", "opacity")).toBe("0.4");
	});
});
