import { getCollection } from "astro:content";
import { PREVIEW_DRAFTS } from "astro:env/server";
import { dropsDrafts, selectPublished } from "../lib/blog-posts";

/**
 * The only reader of the blog collection. Pages, tag routes and the feed all
 * come through here, so the draft filter exists in exactly one place and a
 * page cannot forget it.
 */
export async function publishedPosts() {
	return selectPublished(
		await getCollection("blog"),
		dropsDrafts({ prod: import.meta.env.PROD, previewDrafts: PREVIEW_DRAFTS }),
	);
}
