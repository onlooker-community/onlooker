import { z } from "astro/zod";

// Everything here is pure on purpose. A module that imports astro:content
// only resolves inside Astro's build, and vitest.config.ts runs with
// configFile: false, so the draft guard and the schema have to live where a
// test can load them without that runtime.

export const TAGS = [
	"architecture",
	"plugins",
	"building-onlooker",
	"measurements",
	"marketplace",
] as const;

export type Tag = (typeof TAGS)[number];

export const postSchema = z.object({
	title: z.string(),
	description: z.string(),
	published: z.coerce.date(),
	updated: z.coerce.date().optional(),
	tags: z.array(z.enum(TAGS)).min(1),
	draft: z.boolean().default(false),
	author: z.string().default("Meagan Waller"),
});

export type PostData = z.infer<typeof postSchema>;

export type PostLike = { id: string; data: PostData };

/**
 * The posts a build publishes, newest first. Production drops drafts; dev
 * keeps them, because the site has no staging and dev is the only place a
 * draft can be read rendered (ONL-257 tracks preview deploys).
 */
export function selectPublished<
	T extends { data: { draft: boolean; published: Date } },
>(posts: readonly T[], production: boolean): T[] {
	return posts
		.filter((p) => !production || !p.data.draft)
		.sort((a, b) => b.data.published.valueOf() - a.data.published.valueOf());
}
