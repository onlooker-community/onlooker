import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import ToolCallLedger from "../components/diagrams/ToolCallLedger.astro";

const DIR = new URL("../components/diagrams/", import.meta.url);

// Brand text tokens on brand surfaces are already held to 4.5 by the brand
// package and derived-surfaces.test.ts. A diagram inherits that only if it
// uses nothing else, so this is the check that extends the guarantee to it.
const LITERAL =
	/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])|\brgba?\(|\bhsla?\(/i;

describe("diagrams", () => {
	const files = readdirSync(DIR).filter((f) => f.endsWith(".astro"));

	it("exist, so this check is not passing over an empty folder", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file} uses brand variables, not color literals`, () => {
			const source = readFileSync(new URL(file, DIR), "utf8");
			expect(source.match(LITERAL)?.[0] ?? null).toBeNull();
		});
	}

	it("ToolCallLedger tells a screen reader what it shows", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(ToolCallLedger);
		expect(html).toMatch(/<svg[^>]*role="img"/);
		expect(html).toMatch(/<title[^>]*>[^<]+<\/title>/);
		expect(html).toMatch(/<desc[^>]*>[^<]*tool\.shell\.exec[^<]*<\/desc>/);
	});

	// A wider viewBox scaled into a 328px phone column shrinks 12px text below
	// legibility, so the drawing has to fit in 360 units or less.
	for (const file of files) {
		it(`${file}'s viewBox is no wider than 360 units`, async () => {
			const { default: component } = await import(
				/* @vite-ignore */ new URL(file, DIR).href
			);
			const container = await AstroContainer.create();
			const html = await container.renderToString(component);
			const width = Number(/viewBox="[^"]*\s([\d.]+)\s[\d.]+"/.exec(html)?.[1]);
			expect(width).toBeLessThanOrEqual(360);
		});
	}
});
