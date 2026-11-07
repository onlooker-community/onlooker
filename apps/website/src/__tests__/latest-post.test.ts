import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import LatestPost from "../components/blog/LatestPost.astro";
import { postSchema } from "../lib/blog-posts";

async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(LatestPost, { props });
}

// The landing page shows the newest post so the blog is reachable from /.
// A build with nothing published (every post a draft) must show no line at
// all, not "Latest post:" pointing nowhere.
describe("LatestPost", () => {
	it("links the newest post's title to its path", async () => {
		const html = await render({
			post: {
				id: "contrast-arena",
				data: postSchema.parse({
					title: "The arena",
					description: "What it showed.",
					published: "2026-11-01",
					tags: ["measurements"],
				}),
			},
		});
		expect(html).toContain("Latest post:");
		expect(html).toMatch(
			/<a[^>]*href="\/blog\/contrast-arena\/"[^>]*>The arena →<\/a>/,
		);
	});

	it("renders nothing when no post is published", async () => {
		const html = await render({});
		expect(html).not.toContain("Latest post");
		expect(html).not.toContain("<a");
	});
});
