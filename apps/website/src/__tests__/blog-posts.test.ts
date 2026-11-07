import { getRssString } from "@astrojs/rss";
import { describe, expect, it } from "vitest";
import {
	feedItems,
	formatDate,
	postPath,
	postSchema,
	selectPublished,
	TAGS,
	tagPath,
	tagsInUse,
} from "../lib/blog-posts";

const valid = {
	title: "A post",
	description: "One sentence about it.",
	published: "2026-11-01",
	tags: ["architecture"],
};

const post = (id: string, published: string, draft: boolean) => ({
	id,
	data: { published: new Date(published), draft },
});

describe("selectPublished", () => {
	const posts = [
		post("older", "2026-10-01", false),
		post("draft", "2026-11-05", true),
		post("newer", "2026-11-01", false),
	];

	// This is the guard that keeps an unfinished post off onlooker.dev, which
	// has no staging environment. Delete the filter in selectPublished and this
	// must fail; if it does not, it is not testing the guard.
	it("leaves drafts out of a production build", () => {
		expect(selectPublished(posts, true).map((p) => p.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("keeps drafts under astro dev, so they can be read rendered", () => {
		expect(selectPublished(posts, false).map((p) => p.id)).toEqual([
			"draft",
			"newer",
			"older",
		]);
	});

	it("does not reorder its input in place", () => {
		const before = posts.map((p) => p.id);
		selectPublished(posts, true);
		expect(posts.map((p) => p.id)).toEqual(before);
	});
});

describe("postSchema", () => {
	it("accepts a minimal post and fills the defaults", () => {
		const parsed = postSchema.parse(valid);
		expect(parsed.draft).toBe(false);
		expect(parsed.author).toBe("Meagan Waller");
		expect(parsed.published).toBeInstanceOf(Date);
	});

	it("refuses a tag outside the closed set", () => {
		expect(
			postSchema.safeParse({ ...valid, tags: ["architechture"] }).success,
		).toBe(false);
	});

	it("refuses a post with no tags", () => {
		expect(postSchema.safeParse({ ...valid, tags: [] }).success).toBe(false);
	});

	it("refuses a post with no description", () => {
		const { description: _, ...rest } = valid;
		expect(postSchema.safeParse(rest).success).toBe(false);
	});

	it("knows exactly the five starting tags", () => {
		expect([...TAGS]).toEqual([
			"architecture",
			"plugins",
			"building-onlooker",
			"measurements",
			"marketplace",
		]);
	});
});

describe("tagsInUse", () => {
	const data = (tags: string[]) => postSchema.parse({ ...valid, tags });

	it("lists each tag a post carries, once, in TAGS order", () => {
		const posts = [
			{ id: "a", data: data(["measurements", "architecture"]) },
			{ id: "b", data: data(["architecture"]) },
		];
		expect(tagsInUse(posts)).toEqual(["architecture", "measurements"]);
	});

	it("gives a tag no page until a published post uses it", () => {
		expect(tagsInUse([])).toEqual([]);
	});
});

describe("formatDate", () => {
	// UTC, because frontmatter dates are midnight UTC and a reader west of
	// Greenwich would otherwise see the day before.
	it("formats a frontmatter date as the day it names", () => {
		expect(formatDate(new Date("2026-11-01"))).toBe("November 1, 2026");
	});
});

// Production redirects /x to /x/, so a path without the slash would put a
// redirect in every canonical, feed link and internal href.
describe("paths", () => {
	it("ends a post path in a slash", () => {
		expect(postPath("contrast-arena")).toBe("/blog/contrast-arena/");
	});

	it("ends a tag path in a slash", () => {
		expect(tagPath("measurements")).toBe("/blog/tags/measurements/");
	});
});

describe("the feed", () => {
	const entry = (id: string, published: string) => ({
		id,
		data: postSchema.parse({ ...valid, title: id, published }),
	});
	const posts = [entry("newer", "2026-11-02"), entry("older", "2026-10-01")];

	it("carries each post's title, date, tags and path", () => {
		expect(feedItems(posts)[0]).toEqual({
			title: "newer",
			description: "One sentence about it.",
			pubDate: new Date("2026-11-02"),
			link: "/blog/newer/",
			categories: ["architecture"],
		});
	});

	it("renders absolute links under onlooker.dev, in the order given", async () => {
		const xml = await getRssString({
			title: "Onlooker blog",
			description: "test",
			site: "https://onlooker.dev",
			items: feedItems(posts),
		});
		expect(xml.startsWith("<?xml")).toBe(true);
		// feedItems already ends each link in a slash, and getRssString keeps it.
		const newer = xml.indexOf("<link>https://onlooker.dev/blog/newer/</link>");
		const older = xml.indexOf("<link>https://onlooker.dev/blog/older/</link>");
		expect(newer).toBeGreaterThan(-1);
		expect(older).toBeGreaterThan(newer);
	});
});
