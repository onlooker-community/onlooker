import { getCollection } from "astro:content";
import { selectPublished } from "../lib/blog-posts";

/**
 * The only reader of the blog collection. Pages, tag routes and the feed all
 * come through here, so the draft filter exists in exactly one place and a
 * page cannot forget it.
 */
export async function publishedPosts() {
	return selectPublished(await getCollection("blog"), import.meta.env.PROD);
}
