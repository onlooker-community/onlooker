import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { postSchema } from "./lib/blog-posts";
import { entrySchema } from "./lib/changelog-entries";

const blog = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/blog" }),
	schema: postSchema,
});

const changelog = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/changelog" }),
	schema: entrySchema,
});

export const collections = { blog, changelog };
