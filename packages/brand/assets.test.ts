import { readdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
		expect(files).toHaveLength(80);
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

import { ICON_NAMES, UNPLATED_ICONS } from "./index";

// The union exists so a typo fails at compile time instead of 404ing at
// runtime. That only holds while it matches what is actually on disk, and
// nothing else would notice a file being added or renamed.
describe("the icon name union", () => {
	it("lists exactly the files in the directory", () => {
		const onDisk = readdirSync(iconDir)
			.filter((f) => f.endsWith(".png"))
			.map((f) => f.replace(/\.png$/, ""))
			.sort();
		expect([...ICON_NAMES].sort()).toEqual(onDisk);
	});
});

/**
 * Decode a 16x16 8-bit RGBA non-interlaced PNG into raw RGBA bytes.
 *
 * Deliberately narrow. The test above asserts every icon is exactly 16x16, and
 * all 80 are color type 6 with no interlacing - checked 2026-09-07 - so palette
 * images, 16-bit channels and Adam7 are unreachable here. Handling them would
 * be dead code carrying its own bugs, so this throws instead.
 */
function decodeRgba(path: URL): Buffer {
	const buf = readFileSync(path);
	const [depth, colorType, interlace] = [buf[24], buf[25], buf[28]];
	if (depth !== 8 || colorType !== 6 || interlace !== 0) {
		throw new Error(
			`${path.pathname}: expected 8-bit RGBA non-interlaced, got depth=${depth} colorType=${colorType} interlace=${interlace}`,
		);
	}

	const idat: Buffer[] = [];
	let off = 8;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
		if (type === "IEND") break;
		off += 12 + len;
	}

	// Each scanline is one filter byte followed by the row, and every filter but
	// None refers back to already-reconstructed bytes - so this walks in order
	// and reads from `out`, never from `raw`.
	const raw = inflateSync(Buffer.concat(idat));
	const stride = 16 * 4;
	const out = Buffer.alloc(16 * stride);
	for (let y = 0; y < 16; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(
			y * (stride + 1) + 1,
			y * (stride + 1) + 1 + stride,
		);
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? out[y * stride + x - 4] : 0;
			const up = y > 0 ? out[(y - 1) * stride + x] : 0;
			const upLeft = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
			let v = line[x];
			if (filter === 1) v += left;
			else if (filter === 2) v += up;
			else if (filter === 3) v += Math.floor((left + up) / 2);
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pl = Math.abs(p - left);
				const pu = Math.abs(p - up);
				const pul = Math.abs(p - upLeft);
				v += pl <= pu && pl <= pul ? left : pu <= pul ? up : upLeft;
			}
			out[y * stride + x] = v & 255;
		}
	}
	return out;
}

// Its own copy rather than tokens.test.ts's: those are local, unexported, and
// take hex strings, and this needs RGB straight from decoded pixels.
function channel(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function hexLuminance(hex: string): number {
	return luminance(
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	);
}
function ratio(a: number, b: number): number {
	const [hi, lo] = a > b ? [a, b] : [b, a];
	return (hi + 0.05) / (lo + 0.05);
}

/** The share of an icon's opaque pixels that clear 3:1 against one ground. */
function coverage(path: URL, groundHex: string): number {
	const px = decodeRgba(path);
	const ground = hexLuminance(groundHex);
	let opaque = 0;
	let clearing = 0;
	for (let i = 0; i < px.length; i += 4) {
		// Half-transparent pixels are antialiasing, not the shape.
		if (px[i + 3] < 128) continue;
		opaque++;
		if (ratio(luminance(px[i], px[i + 1], px[i + 2]), ground) >= 3) clearing++;
	}
	return opaque === 0 ? 0 : clearing / opaque;
}

/**
 * The floor, and it comes from the gap in the data rather than from a standard.
 *
 * Measured 2026-09-07: every unplated icon in use lands between 38% and 62% on
 * its worst ground, and the one failure sat at 9-13%. Nothing measures in
 * between, so this has wide margin on both sides.
 *
 * Coverage, and not the "dominant color clears 3:1" that onlooker-1kr asked
 * for. Measured against the night panel, every nav icon fails that at 1.00 to
 * 1.19, because these outlines are deliberately #464074 - the panel color - and
 * the bright bodies carry the shape. Dominant color measures the part of the
 * art designed to recede.
 */
const COVERAGE_FLOOR = 0.25;

/** `--panel` and `--ground` in both themes, from tokens.css. */
const MOVING_GROUNDS: Record<string, string> = {
	"panel at night": "#464074",
	"panel in day": "#b8b8d9",
	"ground at night": "#221f38",
	"ground in day": "#d7d7f2",
};

describe("icons rendered without a plate", () => {
	// This is a legibility rule, not a conformance one. Every Icon in the app is
	// alt="" and role="presentation", so WCAG 1.4.11 does not apply to any of
	// them. An icon 9% legible at night is still bad, which is the whole case
	// for the rule.
	it.each(UNPLATED_ICONS)("%s stays legible on every moving ground", (name) => {
		for (const [where, hex] of Object.entries(MOVING_GROUNDS)) {
			const share = coverage(new URL(`${name}.png`, iconDir), hex);
			// The message carries the measurement, matching how this file
			// already names a missing icon. A bare boolean assertion reports
			// "expected false to be true", and an object matcher omits the
			// properties that did not match - so neither would tell you the one
			// number you need, which is how far under the floor it landed.
			expect(
				share >= COVERAGE_FLOOR,
				`${name} on the ${where}: ${Math.round(share * 100)}% of its opaque pixels clear 3:1, floor is ${COVERAGE_FLOOR * 100}%`,
			).toBe(true);
		}
	});
});
