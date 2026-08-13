import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Layout from "../layouts/Layout.astro";

// CC BY 4.0 requires the credit to travel with the work, and ATTRIBUTION.md
// does not satisfy that - nobody renders that file. This layout wraps every
// page, so the credit living here is what makes the site compliant.
//
// These assertions run against rendered HTML, not the layout's source text.
// The previous version read the .astro file and checked the strings were
// present, which a re-review defeated twice without touching those strings:
// wrapping the credit in an HTML comment, and wrapping it in a false
// conditional. Both times the file still contained the author's name and the
// license URL, the browser rendered neither, and the suite stayed green. A
// license condition guarded by a check that cannot see the page is not guarded.
// Comments are stripped before anything is asserted, and that is the whole
// difference between this check and a weaker one. Astro emits HTML comments
// into its output, so commenting the credit out leaves every string still
// present in the rendered markup - searching the raw render would pass exactly
// as the old source-text check did. This was not theoretical: the first version
// of this fix asserted against the unstripped render and sailed through that
// probe, moving the hole one level down rather than closing it.
async function renderVisibleLayout(): Promise<string> {
	const container = await AstroContainer.create();
	const html = await container.renderToString(Layout, {
		props: { title: "Onlooker", description: "test render" },
	});
	return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("icon attribution", () => {
	it("names the author on the rendered page", async () => {
		expect(await renderVisibleLayout()).toContain("Crusenho Agus Hennihuno");
	});

	it("links the license on the rendered page", async () => {
		expect(await renderVisibleLayout()).toContain(
			"creativecommons.org/licenses/by/4.0",
		);
	});

	// The name and the license have to arrive together. A credit naming the
	// author without linking the license, or vice versa, is not attribution -
	// and each assertion above would still pass on its own.
	it("keeps them in the same credit, not merely both somewhere", async () => {
		const html = await renderVisibleLayout();
		// [^>]* because Astro decorates elements with data-astro-source-* while
		// rendering, so the tag is not simply `<p class="credit">`.
		const credit =
			/<p class="credit"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";

		expect(credit).toContain("Crusenho Agus Hennihuno");
		expect(credit).toContain("creativecommons.org/licenses/by/4.0");
	});
});
