import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { UNPLATED_ICONS } from "@onlooker/brand";
import { describe, expect, it } from "vitest";

// Panel draws its icon in its own h2, with no plate behind it, so the icon has
// to stay legible on the moving panel and ground colors. packages/brand checks
// that only for icons listed in UNPLATED_ICONS, and nothing derives that list
// from the app. The By repository panel used Briefcase, which is not listed,
// and 5% of it cleared 3:1 on the night panel against a 25% floor (ONL-234).
// This closes the gap for Panel: an unlisted icon fails here, not on screen.

// See display-face.test.ts for why import.meta.url goes through a variable.
const moduleUrl = import.meta.url;
const SRC = new URL("../", moduleUrl).pathname;
const ROOTS = ["components", "pages"];

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) return sources(p);
		return /\.tsx?$/.test(entry) ? [p] : [];
	});
}

// Literal names only. A Panel whose icon is an expression cannot be checked
// from source, and none exists today.
const PANEL_ICON = /<Panel\b[^>]*?\bicon="([A-Za-z]+)"/g;

describe("Panel icons", () => {
	const found = ROOTS.flatMap((r) => sources(join(SRC, r))).flatMap((file) =>
		[...readFileSync(file, "utf8").matchAll(PANEL_ICON)].map((m) => ({
			file: file.replace(SRC, ""),
			icon: m[1],
		})),
	);

	// A guard that matches nothing passes vacuously.
	it("finds the panels it is meant to cover", () => {
		expect(found.length).toBeGreaterThan(10);
	});

	it("are all checked against the contrast floor", () => {
		const listed = new Set<string>(UNPLATED_ICONS);
		const unchecked = found
			.filter(({ icon }) => !listed.has(icon))
			.map(({ file, icon }) => `${file}: ${icon}`);
		expect(unchecked, "Panel icon missing from UNPLATED_ICONS").toEqual([]);
	});
});
