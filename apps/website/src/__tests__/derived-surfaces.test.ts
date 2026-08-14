import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// packages/brand guarantees contrast for the two surfaces it defines, --ground
// and --panel, and its test checks every text token against both. This file
// derives a third with color-mix and inherits none of that: the guarantee stops
// at the package boundary, and nothing downstream noticed.
//
// That is how --bg-3 shipped at 82% panel / 18% ink, where --ink-dim measured
// 3.16 at night against the 4.5 body text needs - on the hover surface for
// plugin cards, step lists and table rows, all of which carry text.
//
// So the check lives with the derivation rather than with the tokens. If
// globals.css invents another surface, this is the file that should grow.
const brand = readFileSync(
	new URL("../../../../packages/brand/tokens.css", import.meta.url),
	"utf8",
);
const site = readFileSync(
	new URL("../styles/globals.css", import.meta.url),
	"utf8",
);

/** Read one theme block's custom properties out of a stylesheet. */
function tokens(css: string, selector: string): Record<string, string> {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = new RegExp(`${escaped}\\s*\\{`).exec(css);
	if (!start) throw new Error(`selector not found: ${selector}`);
	const open = css.indexOf("{", start.index);
	let depth = 0;
	let body = "";
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}") {
			depth--;
			if (depth === 0) {
				body = css.slice(open + 1, i);
				break;
			}
		}
	}
	const out: Record<string, string> = {};
	for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})/g)) {
		out[m[1]] = m[2];
	}
	return out;
}

const rgb = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string): number {
	const lin = rgb(hex)
		.map((v) => v / 255)
		.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** The sRGB half of color-mix, which is all this stylesheet uses. */
function colorMix(a: string, percent: number, b: string): string {
	const [x, y] = [rgb(a), rgb(b)];
	return `#${x
		.map((v, i) => Math.round((percent * v + (1 - percent) * y[i]) % 256))
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

/** Pull `--bg-3`'s recipe out of globals.css rather than restating it here. */
function bg3Recipe(): { source: string; percent: number; toward: string } {
	const m =
		/--bg-3:\s*color-mix\(in srgb,\s*var\((--[a-z-]+)\)\s*(\d+)%,\s*var\((--[a-z-]+)\)\)/.exec(
			site,
		);
	if (!m) throw new Error("--bg-3 is no longer a two-token srgb color-mix");
	return { source: m[1], percent: Number(m[2]) / 100, toward: m[3] };
}

// Everything the hover surfaces actually carry: body copy, dimmed captions,
// inline code, and the accent and error colors used in those tables.
const TEXT = ["--ink", "--ink-dim", "--teal", "--red"];

describe("--bg-3, the hover surface derived from --panel", () => {
	const THEMES: Array<[string, string]> = [
		["night", ":root"],
		["day", ':root[data-theme="light"]'],
	];

	for (const [name, selector] of THEMES) {
		it(`${name}: every text token on it clears AA`, () => {
			const t = tokens(brand, selector);
			const { source, percent, toward } = bg3Recipe();
			const surface = colorMix(t[source], percent, t[toward]);

			for (const token of TEXT) {
				expect(
					contrast(t[token], surface),
					`${token} on --bg-3 (${surface}) in ${name}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		});

		// A hover nobody can see is not a hover. This is the reason --bg-3 exists
		// at all, so it is worth asserting alongside the contrast it must keep.
		it(`${name}: it still reads as a change from --panel`, () => {
			const t = tokens(brand, selector);
			const { source, percent, toward } = bg3Recipe();
			const surface = colorMix(t[source], percent, t[toward]);

			expect(contrast(surface, t["--panel"])).toBeGreaterThan(1.2);
		});
	}
});
