import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Abaddon's design size is 16px, so the face is legal at 16/32/48 only. This
// is a source-level check on purpose: no rendering test can see a font size,
// which is exactly how the app came to use the face at 24, 14, 13, 12 and 11px
// across nine files without a single one of 271 tests noticing.

// import.meta.url is read into a variable before use: Vite pattern-matches
// the literal `new URL("...", import.meta.url)` call for its asset-URL
// feature, and mis-resolves it here because "../" names a directory, not an
// asset file. Reading through a variable sidesteps the static match while
// resolving to the same path at runtime.
const moduleUrl = import.meta.url;
const SRC = new URL("../", moduleUrl).pathname;
const LEGAL = [
	"var(--text-display-md)",
	"var(--text-display-lg)",
	"var(--text-display-xl)",
];

// components/ and pages/ only, deliberately. Scanning all of src/ would sweep
// in this file, whose own source contains both the string it greps for and a
// `fontSize:` regex two lines later - so the guard would report itself as an
// offender at a size it invented from its own source code.
const ROOTS = ["components", "pages"];

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) return sources(p);
		return /\.tsx?$/.test(entry) ? [p] : [];
	});
}

describe("the display face", () => {
	it("is never paired with a size that is not an integer multiple of 16px", () => {
		const offenders: string[] = [];
		for (const file of ROOTS.flatMap((r) => sources(join(SRC, r)))) {
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			lines.forEach((line, i) => {
				if (!line.includes("var(--font-display)")) return;
				// The fontSize sits within a few lines of the fontFamily in every
				// existing call site; widen the window rather than the rule if
				// that ever stops being true.
				const window = lines.slice(i, i + 6).join("\n");
				const size = /fontSize:\s*"?([^",\n]+)"?/.exec(window);
				if (!size) return;
				if (!LEGAL.includes(size[1].trim())) {
					offenders.push(
						`${file.replace(SRC, "")}:${i + 1} -> ${size[1].trim()}`,
					);
				}
			});
		}
		expect(offenders, "display face at an illegal size").toEqual([]);
	});
});
