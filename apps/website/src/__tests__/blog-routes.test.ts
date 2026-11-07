import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import PostList from "../components/blog/PostList.astro";
import { postSchema } from "../lib/blog-posts";

const BLOG = new URL("../pages/blog/", import.meta.url);

// middleware.ts sends every path but / back to / while SITE_LAUNCHED is false,
// and it does not run for prerendered pages. Prerendering is the only thing
// that makes the blog public, so losing it on one route takes that route
// down to a redirect with nothing failing.
describe("blog routes", () => {
	const files = readdirSync(BLOG, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.(astro|ts)$/.test(f))
		.sort();

	it("are the ones the spec names", () => {
		expect(files).toEqual([
			"[slug].astro",
			"index.astro",
			"rss.xml.ts",
			"tags/[tag].astro",
		]);
	});

	for (const file of files) {
		it(`${file} is prerendered`, () => {
			expect(readFileSync(new URL(file, BLOG), "utf8")).toMatch(
				/export const prerender = true;/,
			);
		});
	}
});

describe("PostList", () => {
	async function render(posts: unknown[]): Promise<string> {
		const container = await AstroContainer.create();
		return container.renderToString(PostList, { props: { posts } });
	}

	it("says so when nothing is published", async () => {
		expect(await render([])).toContain("Nothing published yet.");
	});

	it("links each post by its slug, with its date and tags", async () => {
		const html = await render([
			{
				id: "contrast-arena",
				data: postSchema.parse({
					title: "The arena",
					description: "What it showed.",
					published: "2026-11-01",
					tags: ["measurements"],
				}),
			},
		]);
		expect(html).toMatch(
			/<a[^>]*href="\/blog\/contrast-arena"[^>]*>The arena<\/a>/,
		);
		expect(html).toContain("November 1, 2026");
		expect(html).toMatch(/href="\/blog\/tags\/measurements"/);
	});
});
