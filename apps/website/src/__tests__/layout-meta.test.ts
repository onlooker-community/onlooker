import { readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import BlogPost from "../layouts/BlogPost.astro";
import Layout from "../layouts/Layout.astro";
import { postSchema } from "../lib/blog-posts";

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
		const html = await render({ canonicalPath: "/blog/a-post/" });
		expect(html).toContain(
			'<link rel="canonical" href="https://onlooker.dev/blog/a-post/">',
		);
		expect(html).toContain(
			'<meta property="og:url" content="https://onlooker.dev/blog/a-post/">',
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
	it("links the blog", async () => {
		expect(await render({})).toMatch(/<a[^>]*href="\/blog\/"[^>]*>Blog<\/a>/);
	});

	it("links to the plugin pages from the nav", async () => {
		expect(await render({})).toMatch(
			/<a class="nav-link" href="\/plugins\/"[^>]*>Plugins<\/a>/,
		);
	});
});

const globals = readFileSync(
	new URL("../styles/globals.css", import.meta.url),
	"utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

// Breadcrumbs are <nav> elements too. While the header was styled through a
// bare `nav` selector, every breadcrumb picked up its space-between, its 48px
// of padding and its bottom border.
describe("site header and breadcrumbs", () => {
	it("styles the header through a class, never a bare nav selector", () => {
		expect(globals).not.toMatch(/(^|[{},])\s*nav\s*[{,]/m);
	});

	it("marks the header nav as the site nav", async () => {
		expect(await render({})).toMatch(/<nav[^>]*class="site-nav"/);
	});

	it("leaves a post's breadcrumb unmarked", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(BlogPost, {
			props: {
				post: {
					id: "a-post",
					data: postSchema.parse({
						title: "A post",
						description: "About it.",
						published: "2026-11-01",
						tags: ["measurements"],
					}),
				},
			},
		});
		const breadcrumb = /<nav[^>]*aria-label="Breadcrumb"[^>]*>/.exec(html)?.[0];
		expect(breadcrumb).toBeDefined();
		expect(breadcrumb).not.toContain("site-nav");
	});
});

// The tag list under a post's title sits inside .prose, and the indent meant
// for markdown lists reached it. Markdown lists carry no class.
describe("prose lists", () => {
	it("indents only unclassed lists", () => {
		expect(globals).toMatch(
			/\.prose :is\(ul, ol\):not\(\[class\]\)\s*\{[^}]*padding-left/,
		);
		expect(globals).not.toMatch(/\.prose ul,\s*\.prose ol\s*\{/);
	});
});
