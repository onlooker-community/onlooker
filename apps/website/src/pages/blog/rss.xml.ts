import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { publishedPosts } from "../../data/blog";
import { feedItems } from "../../lib/blog-posts";
import { SITE_URL } from "../../lib/site";

export const prerender = true;

export async function GET(context: APIContext) {
	return rss({
		title: "Onlooker blog",
		description:
			"How Onlooker and its plugin marketplace are built: the architecture, the measurements, and what they changed.",
		site: context.site ?? SITE_URL,
		items: feedItems(await publishedPosts()),
	});
}
