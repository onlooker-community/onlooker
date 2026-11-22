import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import LatestLink from "../components/LatestLink.astro";

async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(LatestLink, { props });
}

// The landing page names the newest post and the newest changelog entry, so
// both are reachable from /. A build where everything is a draft must show no
// line at all, not "Latest post:" pointing nowhere.
describe("LatestLink", () => {
	it("links the title to its path, under its label", async () => {
		const html = await render({
			label: "Latest post",
			href: "/blog/contrast-arena/",
			title: "The arena",
		});
		expect(html).toContain("Latest post:");
		expect(html).toMatch(
			/<a[^>]*href="\/blog\/contrast-arena\/"[^>]*>The arena →<\/a>/,
		);
	});

	it("renders nothing when there is nothing to link", async () => {
		const html = await render({ label: "Latest update" });
		expect(html).not.toContain("Latest update");
		expect(html).not.toContain("<a");
	});
});
