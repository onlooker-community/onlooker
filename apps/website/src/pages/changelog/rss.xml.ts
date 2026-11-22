import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { publishedEntries } from "../../data/changelog";
import { entryFeedItems } from "../../lib/changelog-entries";
import { SITE_URL } from "../../lib/site";

export const prerender = true;

export async function GET(context: APIContext) {
	return rss({
		title: "Onlooker changelog",
		description:
			"What changed in Onlooker each week: plugin releases, site changes and reliability work.",
		site: context.site ?? SITE_URL,
		items: entryFeedItems(await publishedEntries()),
	});
}
