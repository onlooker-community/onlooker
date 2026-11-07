import { describe, expect, it } from "vitest";
import {
	formatDate,
	postSchema,
	selectPublished,
	TAGS,
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
