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

describe("text accents", () => {
	const themes: Array<[string, string]> = [
		["night", ":root"],
		["day (media)", "@media (prefers-color-scheme: light)"],
		["day (attr)", ':root[data-theme="light"]'],
		["night (attr)", ':root[data-theme="dark"]'],
	];

	// Every token here carries body-size text somewhere: --ink-dim on hints
	// and captions, --red on inline field errors, --teal and --gold on labels
	// and stat readouts. Small text needs AA, and --ground and --panel are the
	// two surfaces this package defines, so both get checked - passing on one
	// proves nothing about the other. That is not the full set of surfaces
	// text lands on in practice: apps that derive their own surface from
	// --panel (a color-mix, an alpha overlay) are not covered here and need
	// their own check. The old threshold was AA-large, which passed --ink-dim
	// at 3.34 on a panel and --red at 4.12. Non-text use has its own rule and
	// its own 3.0 floor; this loop is about text.
	for (const [name, sel] of themes) {
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
