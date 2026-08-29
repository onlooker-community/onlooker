import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** Pull one CSS block's body by its selector text. */
function block(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`${escaped}\\s*\\{`).exec(css);
	if (!match) throw new Error(`selector not found: ${selector}`);
	const open = css.indexOf("{", match.index);
	let depth = 0;
	for (let j = open; j < css.length; j++) {
		if (css[j] === "{") depth++;
		if (css[j] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, j);
		}
	}
	throw new Error(`unbalanced braces after ${selector}`);
}

function tokens(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})/g)) {
		out[m[1]] = m[2];
	}
	return out;
}

function luminance(hex: string): number {
	const c = [1, 3, 5].map(
		(i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
	);
	const lin = c.map((x) =>
		x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const PLATES = ["--plate-gold", "--plate-teal", "--plate-red", "--plate-ink"];
const THEME_SELECTORS = [
	"@media (prefers-color-scheme: light)",
	':root[data-theme="light"]',
	':root[data-theme="dark"]',
];
const ALL_BLOCKS = [":root", ...THEME_SELECTORS];

// Redeclared in every block with the same value, unlike the plates, which are
// declared once on :root. --edge is a decorative divider and lattice color and
// is meant to sit quietly against whatever it crosses, so it does not shift
// with the theme the way an ink token does.
const CONSTANT_ACROSS_THEMES = ["--edge"];

// Every block that carries a full palette, named as the theme a reader is in.
// :root and its data-theme twin are both listed on purpose: they are separate
// blocks, and a guard that checked only one would miss a value drifting in the
// other.
const THEMES: Array<[string, string]> = [
	["night", ":root"],
	["day (media)", "@media (prefers-color-scheme: light)"],
	["day (attr)", ':root[data-theme="light"]'],
	["night (attr)", ':root[data-theme="dark"]'],
];

describe("plate tokens", () => {
	it("are all defined on :root", () => {
		const root = tokens(block(":root"));
		for (const p of PLATES)
			expect(root[p], `${p} missing from :root`).toBeDefined();
	});

	// This is the regression guard. Overriding a plate in a theme block is what
	// produced dark ink on a dark plate at 1.51 contrast, in day mode only.
	it("are never redefined inside a theme block", () => {
		for (const sel of THEME_SELECTORS) {
			const body = block(sel);
			for (const p of PLATES) {
				expect(body.includes(p), `${p} must not appear in ${sel}`).toBe(false);
			}
		}
	});

	it("carry plate-ink at AA or better", () => {
		const t = tokens(block(":root"));
		for (const p of ["--plate-gold", "--plate-teal", "--plate-red"]) {
			expect(
				contrast(t[p], t["--plate-ink"]),
				`${p} vs --plate-ink`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});
});

// Each palette is written out twice: once for the OS preference and once for
// the explicit toggle. Nothing made the copies agree, and the per-block
// contrast checks cannot notice, because each block is only ever measured
// against itself. Setting --teal to the day red in the media query alone left
// the whole suite green - both values clear AA independently - while a reader
// on OS-light saw "active / observing" render red and a reader who had pressed
// the toggle saw teal.
//
// Plates are excluded from both sides. :root carries them and theme blocks
// must never redefine them, but that is a separate rule with its own guard
// above. Excluding only :root's copy made a plate leaking into a theme block
// report here as "absent in :root", which is false and points away from the
// actual problem.
describe("duplicated theme blocks", () => {
	const TWINS: Array<[string, string, string]> = [
		["night", ":root", ':root[data-theme="dark"]'],
		[
			"day",
			"@media (prefers-color-scheme: light)",
			':root[data-theme="light"]',
		],
	];

	for (const [name, a, b] of TWINS) {
		it(`${name}: ${b} matches ${a}`, () => {
			const left = tokens(block(a));
			const right = tokens(block(b));
			for (const p of PLATES) {
				delete left[p];
				delete right[p];
			}

			for (const key of new Set([
				...Object.keys(left),
				...Object.keys(right),
			])) {
				expect(
					right[key],
					`${key} is ${left[key] ?? "absent"} in ${a} but ${
						right[key] ?? "absent"
					} in ${b} - the two must stay in step`,
				).toBe(left[key]);
			}
		});
	}
});

// --edge is decorative: hairline dividers and the website's grid lattice. It is
// deliberately NOT held to the 3:1 that WCAG 1.4.11 asks of a boundary, because
// no constant value could meet it - a border clearing 3.0 against the night
// panel needs luminance >= 0.287, and one clearing it against the day panel
// needs <= 0.132. There is no such color. UI boundaries use --ink-dim instead,
// which shifts per theme and clears 4.74 to 8.06 on both surfaces.
//
// There is deliberately no separate 3.0 assertion for the border token here.
// --ink-dim is already held to the stricter 4.5 text floor on both surfaces in
// every block, so a 3.0 check on it could not fail without that one failing
// first - it would be a test incapable of failing on its own.
//
// What is worth pinning is that --edge stays constant. The twins check compares
// blocks within a theme, so nothing else notices if the night and day copies
// drift apart and the dividers start changing weight with the theme.
describe("constant tokens", () => {
	for (const token of CONSTANT_ACROSS_THEMES) {
		it(`${token} is the same in every block that declares it`, () => {
			const seen = ALL_BLOCKS.map(
				(sel) => [sel, tokens(block(sel))[token]] as const,
			).filter(([, value]) => value !== undefined);

			expect(seen.length, `${token} is declared in no block`).toBeGreaterThan(
				0,
			);
			for (const [sel, value] of seen) {
				expect(
					value,
					`${token} is ${value} in ${sel} but ${seen[0][1]} in ${seen[0][0]} - it is a constant, so every block must agree`,
				).toBe(seen[0][1]);
			}
		});
	}
});

// color-scheme is not a custom property, so the twins check above cannot see
// it - that one compares --token values. Nothing else would notice a block
// losing this, and the symptom would not look like a CSS problem: the browser
// would go back to assuming light and repainting autofilled fields over the
// dark ground.
//
// The value has to agree with the palette in the same block, so this pins the
// pairing rather than merely the presence.
describe("color-scheme", () => {
	const DECLARED: Array<[string, string]> = [
		[":root", "dark"],
		["@media (prefers-color-scheme: light)", "light"],
		[':root[data-theme="light"]', "light"],
		[':root[data-theme="dark"]', "dark"],
	];

	for (const [sel, scheme] of DECLARED) {
		it(`${sel} declares color-scheme: ${scheme}`, () => {
			expect(block(sel)).toMatch(new RegExp(`color-scheme:\\s*${scheme}\\s*;`));
		});
	}
});

describe("text accents", () => {
	// Every token here carries body-size text somewhere: --ink-dim on hints
	// and captions, --red on inline field errors, --teal and --gold on labels
	// and stat readouts. Small text needs AA, and --ground and --panel are the
	// two themed surfaces this package defines, so both get checked - passing on one
	// proves nothing about the other. That is not the full set of surfaces
	// text lands on in practice: apps that derive their own surface from
	// --panel (a color-mix, an alpha overlay) are not covered here and need
	// their own check. The old threshold was AA-large, which passed --ink-dim
	// at 3.34 on a panel and --red at 4.12. Non-text use has its own rule and
	// its own 3.0 floor; this loop is about text.
	for (const [name, sel] of THEMES) {
		for (const surface of ["--ground", "--panel"]) {
			for (const ink of [
				"--ink",
				"--ink-hi",
				"--ink-dim",
				"--gold",
				"--teal",
				"--red",
			]) {
				it(`${name}: ${ink} on ${surface} is at least AA`, () => {
					const t = tokens(block(sel));
					expect(t[ink], `${ink} missing from ${sel}`).toBeDefined();
					expect(contrast(t[ink], t[surface])).toBeGreaterThanOrEqual(4.5);
				});
			}
		}
	}
});

// --shadow is the hard offset that gives the 16-bit treatment its depth, and the
// decision recorded here is that it is decorative and exempt from a contrast
// floor. That is not a concession - no floor is reachable. Against the night
// ground, a PURE BLACK shadow scores 1.32. The shipped #141222 sits at 1.16,
// which is 88% of the theoretical maximum, so there is no color that would make
// the night card shadow clear 3.0, or even 2.0. Same shape as --edge above: the
// constraint is the surface, not the value.
//
// Day is the opposite case and the two should not be conflated. Black would
// score 14.89 on the day ground and 10.90 on the day panel, so day's 1.99 and
// 1.45 are a chosen softness with room to spare, not a ceiling. If the daylight
// card shadow ever wants more weight, it can have it.
//
// What is worth pinning is direction. A shadow lighter than the surface it falls
// on is a glow - it reads as a rendering fault rather than a style, and no
// contrast number would catch it because contrast is unsigned. Mutating --shadow
// to #221f38, the night ground itself, makes the shadow vanish entirely and left
// the whole suite green at 59/59 during the feat/web-auth-brand review. It fails
// here: a shadow equal in luminance to its surface is not darker than it.
//
// Both surfaces are checked because the token lands on both - the 6px card
// shadow falls on --ground, the 4px button shadow falls on --panel.
describe("shadow direction", () => {
	for (const [name, sel] of THEMES) {
		for (const surface of ["--ground", "--panel"]) {
			it(`${name}: --shadow is darker than ${surface}`, () => {
				const t = tokens(block(sel));
				expect(t["--shadow"], `--shadow missing from ${sel}`).toBeDefined();
				expect(
					luminance(t["--shadow"]),
					`--shadow ${t["--shadow"]} must be darker than ${surface} ${t[surface]} - a shadow at or above its surface is a glow`,
				).toBeLessThan(luminance(t[surface]));
			});
		}
	}
});

// --mark is #db3a3a, the Skull icon's red. It is the one value from the icon art
// that failed as a text color - 2.08 on the night panel - and was kept for
// non-text use only: a border, a fill, an icon tint.
//
// Nothing renders it yet. There is no var(--mark) anywhere in apps/ or packages/
// as of this guard being written, and that is the reason to set the floor now
// rather than when something reaches for it. A rule that exists before the first
// consumer is a rule they find; a rule written afterwards is a review comment.
//
// The floor is --ground only, and the asymmetry is real rather than convenient:
// --mark clears 3.0 on the ground in both themes (3.54 night, 6.48 day) and does
// not clear it on the night panel (2.08). Asserting both surfaces would fail the
// token on a use it was never cleared for; asserting neither is where this bead
// started. So the ground is enforced and the panel is written down here.
//
// A consumer putting --mark on the panel at night is outside what this package
// can see, the same way plate boundaries are - that is a rule for the call site.
describe("--mark is ground-only", () => {
	for (const [name, sel] of THEMES) {
		it(`${name}: --mark clears the 3.0 non-text floor on --ground`, () => {
			const t = tokens(block(sel));
			expect(t["--mark"], `--mark missing from ${sel}`).toBeDefined();
			expect(
				contrast(t["--mark"], t["--ground"]),
				`--mark ${t["--mark"]} on --ground ${t["--ground"]}`,
			).toBeGreaterThanOrEqual(3.0);
		});
	}
});

describe("rejected values", () => {
	// Each of these looked right in isolation and failed on the panel.
	const banned = ["#b8791a", "#00755f"];
	it("never reappear", () => {
		for (const hex of banned) expect(css).not.toContain(hex);
	});

	it("allows #db3a3a only as --mark", () => {
		const uses = [...css.matchAll(/(--[a-z-]+)\s*:\s*#db3a3a/g)];
		expect(
			uses.length,
			"#db3a3a should still be present as --mark",
		).toBeGreaterThan(0);
		for (const m of uses)
			expect(m[1], "#db3a3a is non-text only").toBe("--mark");
	});
});

/** Scale tokens carry lengths, not hex, so `tokens()` above cannot see them. */
function lengths(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of body.matchAll(
		/(--[a-z-]+(?:-[a-z0-9]+)?)\s*:\s*([0-9.]+(?:px|rem))/g,
	)) {
		out[m[1]] = m[2];
	}
	return out;
}

describe("scales", () => {
	const root = lengths(block(":root"));

	it("declares a 4px spacing scale", () => {
		expect(
			Object.entries(root).filter(([k]) => k.startsWith("--space-")),
		).toEqual([
			["--space-1", "4px"],
			["--space-2", "8px"],
			["--space-3", "12px"],
			["--space-4", "16px"],
			["--space-5", "24px"],
			["--space-6", "32px"],
			["--space-7", "48px"],
		]);
	});

	// The whole point. Abaddon's design size is 16px - unitsPerEm 1024, and the
	// GCD of every glyph coordinate is 64, so one pixel is 64 units. A pixel
	// face renders crisply only at its design size and integer multiples, so
	// these three are the only legal display sizes and there must be no fourth.
	it("offers exactly three display steps, all integer multiples of 16px", () => {
		const display = Object.entries(root).filter(([k]) =>
			k.startsWith("--text-display-"),
		);
		expect(display).toHaveLength(3);
		for (const [name, value] of display) {
			const px = Number.parseInt(value, 10);
			expect(value, `${name} must be px, not rem`).toMatch(/px$/);
			expect(px % 16, `${name} is ${value}, not a multiple of 16px`).toBe(0);
		}
	});

	// Body copy is the opposite case: it must respect a reader's font-size
	// preference, which px would ignore.
	it("sizes body and data copy in rem", () => {
		for (const [name, value] of Object.entries(root)) {
			if (name.startsWith("--text-body-") || name.startsWith("--text-data-")) {
				expect(value, `${name} must be rem, not px`).toMatch(/rem$/);
			}
		}
	});

	it("keeps the scales off the theme blocks", () => {
		for (const sel of THEME_SELECTORS) {
			const body = block(sel);
			expect(body).not.toMatch(/--space-/);
			expect(body).not.toMatch(/--text-/);
		}
	});
});
