import { getCollection } from "astro:content";
import { PREVIEW_DRAFTS } from "astro:env/server";
import { dropsDrafts } from "../lib/blog-posts";
import { selectPublishedEntries } from "../lib/changelog-entries";

/**
 * The only reader of the changelog collection, for the reason data/blog.ts
 * gives: the draft filter lives in one place, and a page cannot forget it.
 * Drafts follow the blog's rule, so a PR preview shows them.
 */
export async function publishedEntries() {
	return selectPublishedEntries(
		await getCollection("changelog"),
		dropsDrafts({ prod: import.meta.env.PROD, previewDrafts: PREVIEW_DRAFTS }),
	);
}
