import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const iconDir = new URL("./icons/", import.meta.url);

/** Read width and height out of a PNG's IHDR chunk. */
function pngSize(path: URL): { w: number; h: number } {
	const buf = readFileSync(path);
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("icons", () => {
	const files = readdirSync(iconDir).filter((f) => f.endsWith(".png"));

	it("are all present", () => {
		expect(files).toHaveLength(80);
	});

	// Non-integer scaling destroys pixel art. The whole size system depends on
	// every source being exactly 16x16.
	it("are every one exactly 16x16", () => {
		for (const f of files) {
			const { w, h } = pngSize(new URL(f, iconDir));
			expect({ f, w, h }).toEqual({ f, w: 16, h: 16 });
		}
	});

	it("include the ones the brand relies on by name", () => {
		for (const n of [
			"Eye",
			"MagnifyingGlass",
			"Lightbulb",
			"Locked",
			"Unlocked",
			"Team",
			"Skull",
			"Trophy",
			"ChestTreasure",
		]) {
			expect(files, `${n}.png missing`).toContain(`${n}.png`);
		}
	});
});

describe("fonts", () => {
	it("are present and are TrueType", () => {
		for (const f of ["abaddon-bold.ttf", "abaddon-light.ttf"]) {
			const buf = readFileSync(new URL(`./fonts/${f}`, import.meta.url));
			expect(buf.length, `${f} is empty`).toBeGreaterThan(1000);
			// TrueType outlines start with 0x00010000.
			expect(buf.readUInt32BE(0), `${f} is not a TTF`).toBe(0x00010000);
		}
	});
});

describe("attribution", () => {
	const doc = readFileSync(
		new URL("./ATTRIBUTION.md", import.meta.url),
		"utf8",
	);

	// CC BY 4.0 requires the credit to travel with the work.
	it("names the icon author and links the license", () => {
		expect(doc).toContain("Crusenho Agus Hennihuno");
		expect(doc).toContain("creativecommons.org/licenses/by/4.0");
	});

	it("names the font license", () => {
		expect(doc).toContain("creativecommons.org/licenses/by/3.0");
	});
});
