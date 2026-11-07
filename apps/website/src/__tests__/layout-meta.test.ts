import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Layout from "../layouts/Layout.astro";

// Rendered, not read as source, for the reason credit.test.ts gives: a string
// in a file does not establish that a browser or a link unfurler sees it.
async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	const html = await container.renderToString(Layout, {
		props: { title: "A page", description: "About it.", ...props },
	});
	return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("Layout meta", () => {
	it("titles the share card after the page, not the site", async () => {
		expect(await render({})).toContain(
			'<meta property="og:title" content="A page">',
		);
	});

	it("points canonical and og:url at onlooker.dev", async () => {
		const html = await render({ canonicalPath: "/blog/a-post" });
		expect(html).toContain(
			'<link rel="canonical" href="https://onlooker.dev/blog/a-post">',
		);
		expect(html).toContain(
			'<meta property="og:url" content="https://onlooker.dev/blog/a-post">',
		);
	});

	it("marks a post as an article with its date", async () => {
		const html = await render({
			ogType: "article",
			publishedTime: new Date("2026-11-01T00:00:00Z"),
		});
		expect(html).toContain('<meta property="og:type" content="article">');
		expect(html).toContain(
			'<meta property="article:published_time" content="2026-11-01T00:00:00.000Z">',
		);
	});

	it("is a website with no article date by default", async () => {
		const html = await render({});
		expect(html).toContain('<meta property="og:type" content="website">');
		expect(html).not.toContain("article:published_time");
	});

	it("advertises the feed", async () => {
		expect(await render({})).toContain(
			'<link rel="alternate" type="application/rss+xml" title="Onlooker blog" href="/blog/rss.xml">',
		);
	});
});

describe("Layout nav", () => {
	it("links the blog and the plugin library", async () => {
		const html = await render({});
		expect(html).toMatch(/<a[^>]*href="\/blog"[^>]*>Blog<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/plugins"[^>]*>Plugins<\/a>/);
	});
});
