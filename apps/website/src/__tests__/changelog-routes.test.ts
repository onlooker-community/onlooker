import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import EntryList from "../components/changelog/EntryList.astro";
import PluginReleases from "../components/changelog/PluginReleases.astro";
import { entrySchema } from "../lib/changelog-entries";

const CHANGELOG = new URL("../pages/changelog/", import.meta.url);

// Static content, so every route prerenders, as the blog's do.
describe("changelog routes", () => {
	const files = readdirSync(CHANGELOG, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.(astro|ts)$/.test(f))
		.sort();

	it("are the ones ONL-302 names", () => {
		expect(files).toEqual(["[slug].astro", "index.astro", "rss.xml.ts"]);
	});

	for (const file of files) {
		it(`${file} is prerendered`, () => {
			expect(readFileSync(new URL(file, CHANGELOG), "utf8")).toMatch(
				/export const prerender = true;/,
			);
		});
	}
});

async function render(
	component: Parameters<AstroContainer["renderToString"]>[0],
	props: Record<string, unknown>,
): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(component, { props });
}

describe("EntryList", () => {
	it("says so when nothing is published", async () => {
		expect(await render(EntryList, { entries: [] })).toContain(
			"Nothing published yet.",
		);
	});

	it("links each entry by its week, with the week and summary", async () => {
		const html = await render(EntryList, {
			entries: [
				{
					id: "2026-11-20",
					data: entrySchema.parse({
						title: "Lock fix",
						weekStart: "2026-11-14",
						weekEnd: "2026-11-20",
						summary: "What changed.",
					}),
				},
			],
		});
		expect(html).toMatch(
			/<a[^>]*href="\/changelog\/2026-11-20\/"[^>]*>Lock fix<\/a>/,
		);
		expect(html).toContain("November 14 to 20, 2026");
		expect(html).toContain('datetime="2026-11-20"');
		expect(html).toContain("What changed.");
	});
});

describe("PluginReleases", () => {
	it("links each release to its plugin page", async () => {
		const html = await render(PluginReleases, {
			plugins: [{ name: "lineage", version: "0.10.5" }],
		});
		expect(html).toMatch(
			/<a[^>]*href="\/plugins\/lineage\/"[^>]*>lineage 0\.10\.5<\/a>/,
		);
		expect(html).toContain('aria-label="Plugin releases this week"');
	});

	it("renders nothing for a week with no releases", async () => {
		const html = await render(PluginReleases, { plugins: [] });
		expect(html).not.toContain("<ul");
	});
});
