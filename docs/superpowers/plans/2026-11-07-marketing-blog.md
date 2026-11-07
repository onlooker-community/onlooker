# Marketing Blog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a prerendered MDX blog at onlooker.dev/blog, with tags, RSS, brand-themed code and diagrams, and one real post.

**Architecture:** An Astro content collection (`glob` loader, `.mdx`) whose schema, tag list and draft filter live in a pure module that vitest can import. Thin pages under `src/pages/blog/` read posts only through `publishedPosts()`. Every blog route is prerendered, which is what puts it past the `SITE_LAUNCHED` middleware gate (superseded by Task 5a: middleware runs during prerender; the gate names `/blog`).

**Tech Stack:** Astro 6.4 (`output: "server"`, Cloudflare adapter), `@astrojs/mdx` 5.x, `@astrojs/rss` 4.x, Shiki `css-variables` theme, vitest 4 with `getViteConfig`, Biome (tabs).

Spec: `docs/superpowers/specs/2026-11-07-marketing-blog-design.md`. Linear: ONL-259.

## Global Constraints

- Work in the worktree `/Users/meaganwaller/src/github.com/onlooker-community/onlooker-onl-259`, branch `meagan/onl-259-marketing-blog`. Never `cd` into the main checkout; another session uses it.
- Edit tracked files with the Edit/Write tools, never `sed -i` or heredocs (CLAUDE.md: lineage and inspector only see tool edits).
- Commit through `/git-workflow:commit` only. Every commit body ends with `Refs ONL-259`.
- Run one test file with `pnpm --filter @onlooker/website test <name>`, with **no `--`**. `test -- <name>` runs the whole suite.
- `@astrojs/mdx@^5.0.6` (its peer is `astro ^6.0.0`; 6.x needs `@astrojs/markdown-satteri`, which Astro 6.4.8 does not use; 7.x needs Astro 7). `@astrojs/rss@^4.0.19`.
- Every blog route file exports `prerender = true`.
- Nothing calls `getCollection("blog")` except `publishedPosts()` in `src/data/blog.ts`.
- Diagram components use brand CSS variables only: no hex, `rgb(`, or `hsl(` literals.
- Tags are exactly: `architecture`, `plugins`, `building-onlooker`, `measurements`, `marketplace`.
- American English in code, comments and copy.
- Comment density matches the surrounding code: this codebase explains *why* in full sentences, citing measurements. Do not add comments that restate the code.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/website/src/lib/site.ts` (new) | `SITE_URL`, the one place the origin is written |
| `apps/website/src/lib/blog-posts.ts` (new) | `TAGS`, `postSchema`, `selectPublished`, `tagsInUse`, `feedItems`, `formatDate`. Pure, no `astro:*` imports |
| `apps/website/src/content.config.ts` (new) | registers the `blog` collection with `postSchema` |
| `apps/website/src/data/blog.ts` (new) | `publishedPosts()`, the only `getCollection("blog")` caller |
| `apps/website/src/layouts/Layout.astro` (modify) | meta props, canonical, RSS link, nav links |
| `apps/website/src/layouts/BlogPost.astro` (new) | post page frame |
| `apps/website/src/components/blog/PostList.astro` (new) | the list shared by `/blog` and tag pages, with the empty state |
| `apps/website/src/pages/blog/index.astro`, `[slug].astro`, `tags/[tag].astro`, `rss.xml.ts` (new) | routes |
| `apps/website/src/components/diagrams/ToolCallLedger.astro` (new) | the first post's diagram |
| `apps/website/src/content/blog/contrast-arena.mdx` (new) | the first post |
| `apps/website/src/styles/globals.css` (modify) | nav links, `--astro-code-*`, prose, code block styles |
| `apps/website/src/middleware.ts` (modify) | comment naming `/blog` as public-because-prerendered (superseded by Task 5a: middleware runs during prerender; the gate names `/blog`) |
| `apps/website/astro.config.mjs` (modify) | `site`, `mdx()`, `shikiConfig` |
| `apps/website/src/__tests__/blog-posts.test.ts`, `layout-meta.test.ts`, `blog-routes.test.ts`, `diagram-colors.test.ts` (new); `derived-surfaces.test.ts` (modify) | tests |

---

### Task 0: Set up the worktree

- [ ] **Step 1: Pull the Linear issue into beads and claim it**

```bash
cd /Users/meaganwaller/src/github.com/onlooker-community/onlooker-onl-259
bd linear pull ONL-259
bd update <bead-id-printed-above> --claim
```

Create one child bead per task below with `bd create --parent <bead-id> "<task title>"`.

- [ ] **Step 2: Install dependencies and confirm the suite is green before touching anything**

```bash
pnpm install
pnpm --filter @onlooker/website test
pnpm --filter @onlooker/website typecheck
```

Expected: all pass. If anything fails here, stop and report it. It is not this plan's failure to fix.

---

### Task 1: Content model

**Files:**
- Create: `apps/website/src/lib/site.ts`, `apps/website/src/lib/blog-posts.ts`, `apps/website/src/content.config.ts`, `apps/website/src/data/blog.ts`, `apps/website/src/content/blog/.gitkeep`
- Modify: `apps/website/astro.config.mjs`, `apps/website/package.json`
- Test: `apps/website/src/__tests__/blog-posts.test.ts`

**Interfaces:**
- Produces:
  - `SITE_URL: "https://onlooker.dev"` from `src/lib/site.ts`
  - `TAGS: readonly ["architecture","plugins","building-onlooker","measurements","marketplace"]`, `type Tag`
  - `postSchema` (Zod object), `type PostData = z.infer<typeof postSchema>`
  - `type PostLike = { id: string; data: PostData }`
  - `selectPublished<T extends { data: { draft: boolean; published: Date } }>(posts: readonly T[], production: boolean): T[]`
  - `publishedPosts(): Promise<CollectionEntry<"blog">[]>` from `src/data/blog.ts`

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter @onlooker/website add @astrojs/mdx@^5.0.6 @astrojs/rss@^4.0.19
```

Expected: both land in `dependencies` in `apps/website/package.json` and `pnpm-lock.yaml` updates. No peer warnings for `astro`.

- [ ] **Step 2: Write the failing tests**

`apps/website/src/__tests__/blog-posts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { postSchema, selectPublished, TAGS } from "../lib/blog-posts";

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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test blog-posts`
Expected: FAIL, cannot resolve `../lib/blog-posts`.

- [ ] **Step 4: Write the implementation**

`apps/website/src/lib/site.ts`:

```ts
/** The marketing origin. astro.config.mjs's `site` and every canonical URL read it. */
export const SITE_URL = "https://onlooker.dev";
```

`apps/website/src/lib/blog-posts.ts`:

```ts
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
```

`apps/website/src/content.config.ts`:

```ts
import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { postSchema } from "./lib/blog-posts";

const blog = defineCollection({
	loader: glob({ pattern: "**/*.mdx", base: "./src/content/blog" }),
	schema: postSchema,
});

export const collections = { blog };
```

`apps/website/src/data/blog.ts`:

```ts
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
```

Create the empty file `apps/website/src/content/blog/.gitkeep`.

In `apps/website/astro.config.mjs`, add the imports and two settings. Keep the existing `vite` block and its comment untouched:

```js
import cloudflare from "@astrojs/cloudflare";
import mdx from "@astrojs/mdx";
import sentry from "@sentry/astro";
import { defineConfig, envField } from "astro/config";
import { SITE_URL } from "./src/lib/site.ts";

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	output: "server",
	adapter: cloudflare(),
	// ...the existing vite block, unchanged...
	integrations: [
		mdx(),
		sentry({
			// ...unchanged...
		}),
	],
	// ...env, unchanged...
});
```

- [ ] **Step 5: Run the tests to verify they pass, then prove the guard by ablation**

Run: `pnpm --filter @onlooker/website test blog-posts`
Expected: PASS, 8 tests.

Then temporarily change `.filter((p) => !production || !p.data.draft)` to `.filter(() => true)` and run again. Expected: "leaves drafts out of a production build" FAILS. Restore the line and run again: PASS.

- [ ] **Step 6: Typecheck and build**

```bash
pnpm --filter @onlooker/website typecheck
pnpm --filter @onlooker/website build
```

Expected: both succeed. The build may warn that `src/content/blog` matched no files; that's expected until Task 7.

- [ ] **Step 7: Commit**

Through `/git-workflow:commit`, staging: `apps/website/package.json`, `pnpm-lock.yaml`, `apps/website/astro.config.mjs`, `apps/website/src/lib/site.ts`, `apps/website/src/lib/blog-posts.ts`, `apps/website/src/content.config.ts`, `apps/website/src/data/blog.ts`, `apps/website/src/content/blog/.gitkeep`, `apps/website/src/__tests__/blog-posts.test.ts`. Suggested subject: `feat(website): give posts a schema that refuses drafts in production`.

---

### Task 2: Layout meta and navigation

**Files:**
- Modify: `apps/website/src/layouts/Layout.astro`, `apps/website/src/styles/globals.css:110-168`
- Test: `apps/website/src/__tests__/layout-meta.test.ts`

**Interfaces:**
- Consumes: `SITE_URL` from Task 1.
- Produces: `Layout` props `{ title: string; description: string; ogType?: "website" | "article"; publishedTime?: Date; canonicalPath?: string }`.

- [ ] **Step 1: Write the failing tests**

`apps/website/src/__tests__/layout-meta.test.ts`:

```ts
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Layout from "../layouts/Layout.astro";

// Rendered, not read as source, for the reason credit.test.ts gives: a string
// in a file does not establish that a browser or a link unfurler sees it.
async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	const html = await container.renderToString(Layout, {
		props: { title: "A page", description: "About it.", ...props },
	});
	return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("Layout meta", () => {
	it("titles the share card after the page, not the site", async () => {
		expect(await render({})).toContain(
			'<meta property="og:title" content="A page">',
		);
	});

	it("points canonical and og:url at onlooker.dev", async () => {
		const html = await render({ canonicalPath: "/blog/a-post" });
		expect(html).toContain(
			'<link rel="canonical" href="https://onlooker.dev/blog/a-post">',
		);
		expect(html).toContain(
			'<meta property="og:url" content="https://onlooker.dev/blog/a-post">',
		);
	});

	it("marks a post as an article with its date", async () => {
		const html = await render({
			ogType: "article",
			publishedTime: new Date("2026-11-01T00:00:00Z"),
		});
		expect(html).toContain('<meta property="og:type" content="article">');
		expect(html).toContain(
			'<meta property="article:published_time" content="2026-11-01T00:00:00.000Z">',
		);
	});

	it("is a website with no article date by default", async () => {
		const html = await render({});
		expect(html).toContain('<meta property="og:type" content="website">');
		expect(html).not.toContain("article:published_time");
	});

	it("advertises the feed", async () => {
		expect(await render({})).toContain(
			'<link rel="alternate" type="application/rss+xml" title="Onlooker blog" href="/blog/rss.xml">',
		);
	});
});

describe("Layout nav", () => {
	it("links the blog and the plugin library", async () => {
		const html = await render({});
		expect(html).toMatch(/<a[^>]*href="\/blog"[^>]*>Blog<\/a>/);
		expect(html).toMatch(/<a[^>]*href="\/plugins"[^>]*>Plugins<\/a>/);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test layout-meta`
Expected: FAIL on og:title (currently the literal "Onlooker"), canonical, feed and nav.

Astro may serialize void elements as `<meta ...>` or `<meta ... />`. If a failure is only that difference, change the expected strings to match what Astro emits (check the existing render in `credit.test.ts` output) and leave the assertions otherwise unchanged.

- [ ] **Step 3: Write the implementation**

Replace the frontmatter and `<head>`/`<nav>` of `apps/website/src/layouts/Layout.astro`, keeping the footer, radar and everything else as it is:

```astro
---
import "../styles/globals.css";
import { SITE_URL } from "../lib/site";

interface Props {
	title: string;
	description: string;
	ogType?: "website" | "article";
	publishedTime?: Date;
	canonicalPath?: string;
}

const {
	title,
	description,
	ogType = "website",
	publishedTime,
	canonicalPath = Astro.url.pathname,
} = Astro.props;

const canonical = new URL(canonicalPath, SITE_URL).href;
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content={ogType} />
    <meta property="og:url" content={canonical} />
    {publishedTime && (
      <meta property="article:published_time" content={publishedTime.toISOString()} />
    )}
    <link rel="alternate" type="application/rss+xml" title="Onlooker blog" href="/blog/rss.xml" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <div class="page">
      <nav>
        <a class="logo" href="/">
          <span class="logo-pulse"></span>
          Onlooker
        </a>
        <div class="nav-right">
          <a class="nav-link" href="/blog">Blog</a>
          <a class="nav-link" href="/plugins">Plugins</a>
          <span class="nav-tag">Early Access</span>
        </div>
      </nav>
```

In `apps/website/src/styles/globals.css`, directly after the `.nav-tag` rule (line 168):

```css
.nav-right {
	display: flex;
	align-items: center;
	gap: 20px;
}

.nav-link {
	font-family: var(--mono);
	font-size: 12px;
	color: var(--text-2);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	text-decoration: none;
}

.nav-link:hover,
.nav-link:focus-visible {
	color: var(--accent);
}

/* Two links joined the logo and the tag, and at 48px of side padding the row
 * no longer fits a 360px phone. */
@media (max-width: 640px) {
	nav {
		padding: 20px 16px;
	}

	.nav-right {
		gap: 14px;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/website test layout-meta`, then `pnpm --filter @onlooker/website test credit`
Expected: both PASS. The credit test renders the same layout and must stay green.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, staging `Layout.astro`, `globals.css`, `layout-meta.test.ts`. Suggested subject: `feat(website): name each page in its share card and link the blog`.

---

### Task 3: Code blocks in brand colors

**Files:**
- Modify: `apps/website/astro.config.mjs`, `apps/website/src/styles/globals.css`, `apps/website/src/__tests__/derived-surfaces.test.ts`

**Interfaces:**
- Produces: the `--astro-code-*` properties and the `.astro-code` block style that Task 4's prose uses.

- [ ] **Step 1: Write the failing tests**

Append to `apps/website/src/__tests__/derived-surfaces.test.ts`, reusing the file's `tokens`, `contrast`, `brand` and `site`:

```ts
// The css-variables theme colors every token through these properties. Each
// one globals.css leaves undefined renders in the theme's fallback, which
// knows nothing about either brand theme, so the set is asserted whole.
const ASTRO_CODE = [
	"--astro-code-foreground",
	"--astro-code-background",
	"--astro-code-token-constant",
	"--astro-code-token-string",
	"--astro-code-token-comment",
	"--astro-code-token-keyword",
	"--astro-code-token-parameter",
	"--astro-code-token-function",
	"--astro-code-token-string-expression",
	"--astro-code-token-punctuation",
	"--astro-code-token-link",
];

/** `--astro-code-x: var(--brand-token)` pairs, read from globals.css. */
function codeMapping(): Record<string, string> {
	return Object.fromEntries(
		[...site.matchAll(/(--astro-code-[a-z-]+)\s*:\s*var\((--[a-z-]+)\)/g)].map(
			(m) => [m[1], m[2]],
		),
	);
}

describe("code blocks, drawn from brand tokens", () => {
	it("maps every property the css-variables theme emits", () => {
		expect(Object.keys(codeMapping()).sort()).toEqual([...ASTRO_CODE].sort());
	});

	const THEMES: Array<[string, string]> = [
		["night", ":root"],
		["day", ':root[data-theme="light"]'],
	];

	for (const [name, selector] of THEMES) {
		it(`${name}: every code color clears AA on the code background`, () => {
			const t = tokens(brand, selector);
			const map = codeMapping();
			const background = t[map["--astro-code-background"]];

			for (const prop of ASTRO_CODE) {
				if (prop === "--astro-code-background") continue;
				expect(
					contrast(t[map[prop]], background),
					`${prop} (${map[prop]}) on ${map["--astro-code-background"]} in ${name}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test derived-surfaces`
Expected: the new "maps every property" test FAILS (the mapping is empty), and the existing `--bg-3` tests still PASS.

- [ ] **Step 3: Write the implementation**

In `apps/website/astro.config.mjs`, add a top-level `markdown` key next to `integrations`:

```js
	markdown: {
		shikiConfig: { theme: "css-variables" },
	},
```

In `apps/website/src/styles/globals.css`, after the existing `:root` alias block:

```css
/* Code blocks. Shiki's css-variables theme colors every token through these,
 * so pointing them at brand tokens is what makes code switch themes with the
 * page. Each pairing is checked at 4.5 against --panel in both themes by
 * derived-surfaces.test.ts; the lowest, measured 2026-11-07, is --red at
 * night at 4.67. */
:root {
	--astro-code-background: var(--panel);
	--astro-code-foreground: var(--ink);
	--astro-code-token-keyword: var(--teal);
	--astro-code-token-string: var(--gold);
	--astro-code-token-string-expression: var(--gold);
	--astro-code-token-comment: var(--ink-dim);
	--astro-code-token-constant: var(--red);
	--astro-code-token-function: var(--ink-hi);
	--astro-code-token-parameter: var(--ink);
	--astro-code-token-punctuation: var(--ink-dim);
	--astro-code-token-link: var(--teal);
}

.astro-code {
	font-family: var(--mono);
	font-size: var(--text-data-md);
	line-height: 1.6;
	padding: 16px 20px;
	border: 1px solid var(--border);
	border-radius: 6px;
	/* Long lines scroll inside the block, never the page. */
	overflow-x: auto;
}
```

- [ ] **Step 4: Run the tests to verify they pass, then ablate**

Run: `pnpm --filter @onlooker/website test derived-surfaces`
Expected: PASS.

Then temporarily set `--astro-code-token-comment: var(--edge);` and run again. Expected: both theme tests FAIL on `--astro-code-token-comment`. Restore `var(--ink-dim)` and confirm PASS.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, staging `astro.config.mjs`, `globals.css`, `derived-surfaces.test.ts`. Suggested subject: `feat(website): color code from brand tokens and hold it to AA`.

---

### Task 4: Blog routes

**Files:**
- Modify: `apps/website/src/lib/blog-posts.ts`, `apps/website/src/middleware.ts`, `apps/website/src/styles/globals.css`
- Create: `apps/website/src/components/blog/PostList.astro`, `apps/website/src/layouts/BlogPost.astro`, `apps/website/src/pages/blog/index.astro`, `apps/website/src/pages/blog/[slug].astro`, `apps/website/src/pages/blog/tags/[tag].astro`
- Test: `apps/website/src/__tests__/blog-posts.test.ts` (extend), `apps/website/src/__tests__/blog-routes.test.ts`

**Interfaces:**
- Consumes: `publishedPosts()`, `PostLike`, `TAGS`, `Tag` (Task 1); `Layout` props (Task 2).
- Produces: `tagsInUse(posts: readonly PostLike[]): Tag[]`, `formatDate(d: Date): string`; `PostList` props `{ posts: PostLike[] }`; `BlogPost` props `{ post: PostLike }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/website/src/__tests__/blog-posts.test.ts` (and add `formatDate, tagsInUse` to its import from `../lib/blog-posts`):

```ts
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
```

`apps/website/src/__tests__/blog-routes.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import PostList from "../components/blog/PostList.astro";
import { postSchema } from "../lib/blog-posts";

const BLOG = new URL("../pages/blog/", import.meta.url);

// middleware.ts sends every path but / back to / while SITE_LAUNCHED is false,
// and it does not run for prerendered pages. Prerendering is the only thing
// that makes the blog public, so losing it on one route takes that route
// down to a redirect with nothing failing.
describe("blog routes", () => {
	const files = readdirSync(BLOG, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.(astro|ts)$/.test(f))
		.sort();

	it("are the ones the spec names", () => {
		expect(files).toEqual(["[slug].astro", "index.astro", "tags/[tag].astro"]);
	});

	for (const file of files) {
		it(`${file} is prerendered`, () => {
			expect(readFileSync(new URL(file, BLOG), "utf8")).toMatch(
				/export const prerender = true;/,
			);
		});
	}
});

describe("PostList", () => {
	async function render(posts: unknown[]): Promise<string> {
		const container = await AstroContainer.create();
		return container.renderToString(PostList, { props: { posts } });
	}

	it("says so when nothing is published", async () => {
		expect(await render([])).toContain("Nothing published yet.");
	});

	it("links each post by its slug, with its date and tags", async () => {
		const html = await render([
			{
				id: "contrast-arena",
				data: postSchema.parse({
					title: "The arena",
					description: "What it showed.",
					published: "2026-11-01",
					tags: ["measurements"],
				}),
			},
		]);
		expect(html).toMatch(/<a[^>]*href="\/blog\/contrast-arena"[^>]*>The arena<\/a>/);
		expect(html).toContain("November 1, 2026");
		expect(html).toMatch(/href="\/blog\/tags\/measurements"/);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test blog-posts`, then `pnpm --filter @onlooker/website test blog-routes`
Expected: both FAIL (missing exports, missing files).

- [ ] **Step 3: Add the helpers to `src/lib/blog-posts.ts`**

```ts
export function tagsInUse(posts: readonly PostLike[]): Tag[] {
	const used = new Set(posts.flatMap((p) => p.data.tags));
	return TAGS.filter((t) => used.has(t));
}

const DATE = new Intl.DateTimeFormat("en-US", {
	dateStyle: "long",
	timeZone: "UTC",
});

export function formatDate(d: Date): string {
	return DATE.format(d);
}
```

- [ ] **Step 4: Write the components and pages**

`apps/website/src/components/blog/PostList.astro`:

```astro
---
import { formatDate, type PostLike } from "../../lib/blog-posts";

interface Props {
	posts: PostLike[];
}

const { posts } = Astro.props;
---

{
  posts.length === 0 ? (
    <p class="post-empty">Nothing published yet.</p>
  ) : (
    <ol class="post-list">
      {posts.map((post) => (
        <li class="post-item">
          <time datetime={post.data.published.toISOString()}>
            {formatDate(post.data.published)}
          </time>
          <h2 class="post-title">
            <a href={`/blog/${post.id}`}>{post.data.title}</a>
          </h2>
          <p class="post-description">{post.data.description}</p>
          <ul class="post-tags">
            {post.data.tags.map((tag) => (
              <li>
                <a href={`/blog/tags/${tag}`}>{tag}</a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}
```

`apps/website/src/layouts/BlogPost.astro`:

```astro
---
import { formatDate, type PostLike } from "../lib/blog-posts";
import Layout from "./Layout.astro";

interface Props {
	post: PostLike;
}

const { post } = Astro.props;
const { title, description, published, updated, tags, author } = post.data;
---

<Layout
  title={`${title} — Onlooker`}
  description={description}
  ogType="article"
  publishedTime={published}
  canonicalPath={`/blog/${post.id}`}
>
  <main class="prose-page">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="sep">/</span>
      <a href="/blog">Blog</a>
    </nav>
    <article class="prose">
      <header class="post-header">
        <h1>{title}</h1>
        <p class="post-meta">
          <time datetime={published.toISOString()}>{formatDate(published)}</time>
          <span>· {author}</span>
          {updated && (
            <span>· Updated <time datetime={updated.toISOString()}>{formatDate(updated)}</time></span>
          )}
        </p>
        <ul class="post-tags">
          {tags.map((tag) => (
            <li><a href={`/blog/tags/${tag}`}>{tag}</a></li>
          ))}
        </ul>
      </header>
      <slot />
    </article>
  </main>
</Layout>
```

`apps/website/src/pages/blog/index.astro`:

```astro
---
import PostList from "../../components/blog/PostList.astro";
import { publishedPosts } from "../../data/blog";
import Layout from "../../layouts/Layout.astro";

export const prerender = true;

const posts = await publishedPosts();
---

<Layout
  title="Blog — Onlooker"
  description="How Onlooker and its plugin marketplace are built: the architecture, the measurements, and what they changed."
>
  <main class="prose-page">
    <header class="page-header">
      <p class="eyebrow">Blog</p>
      <h1>How Onlooker is built</h1>
    </header>
    <PostList posts={posts} />
  </main>
</Layout>
```

`apps/website/src/pages/blog/[slug].astro`:

```astro
---
import { render } from "astro:content";
import { publishedPosts } from "../../data/blog";
import BlogPost from "../../layouts/BlogPost.astro";

export const prerender = true;

export async function getStaticPaths() {
	return (await publishedPosts()).map((post) => ({
		params: { slug: post.id },
		props: { post },
	}));
}

const { post } = Astro.props;
const { Content } = await render(post);
---

<BlogPost post={post}>
  <Content />
</BlogPost>
```

`apps/website/src/pages/blog/tags/[tag].astro`:

```astro
---
import PostList from "../../../components/blog/PostList.astro";
import { publishedPosts } from "../../../data/blog";
import Layout from "../../../layouts/Layout.astro";
import { tagsInUse } from "../../../lib/blog-posts";

export const prerender = true;

export async function getStaticPaths() {
	const posts = await publishedPosts();
	return tagsInUse(posts).map((tag) => ({
		params: { tag },
		props: { tag, posts: posts.filter((p) => p.data.tags.includes(tag)) },
	}));
}

const { tag, posts } = Astro.props;
---

<Layout title={`Posts tagged ${tag} — Onlooker`} description={`Onlooker blog posts tagged ${tag}.`}>
  <main class="prose-page">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="sep">/</span>
      <a href="/blog">Blog</a>
    </nav>
    <header class="page-header">
      <p class="eyebrow">Tag</p>
      <h1>{tag}</h1>
    </header>
    <PostList posts={posts} />
  </main>
</Layout>
```

- [ ] **Step 5: Style the blog**

Append to `apps/website/src/styles/globals.css`. Before writing, read how `src/pages/plugins/index.astro` styles `.breadcrumb`, `.eyebrow` and `.page-header` in its scoped `<style>`, and copy those rules here unchanged, so the blog matches the plugin pages:

```css
/* Blog. The reading column is 68ch: long enough for a code line, short
 * enough to read prose without losing the line. */
.prose-page {
	flex: 1;
	width: 100%;
	max-width: 68ch;
	margin: 0 auto;
	padding: 56px 16px 80px;
}

.post-list {
	list-style: none;
	display: flex;
	flex-direction: column;
	gap: 40px;
}

.post-item time,
.post-meta {
	font-family: var(--mono);
	font-size: 12px;
	color: var(--text-3);
	letter-spacing: 0.04em;
}

.post-title {
	font-family: var(--display);
	font-size: 22px;
	line-height: 1.25;
	margin: 6px 0 8px;
}

.post-title a {
	color: var(--text-1);
	text-decoration: none;
}

.post-title a:hover,
.post-title a:focus-visible {
	color: var(--accent);
}

.post-description,
.post-empty {
	color: var(--text-2);
	line-height: 1.6;
}

.post-tags {
	list-style: none;
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 12px;
}

.post-tags a {
	font-family: var(--mono);
	font-size: 11px;
	color: var(--text-2);
	padding: 3px 10px;
	border: 1px solid var(--border);
	border-radius: 100px;
	text-decoration: none;
}

.post-tags a:hover,
.post-tags a:focus-visible {
	color: var(--accent);
	border-color: var(--accent);
}

.post-header {
	margin-bottom: 40px;
}

.post-header h1 {
	font-family: var(--display);
	font-size: clamp(28px, 5vw, 40px);
	line-height: 1.1;
	color: var(--text-1);
	margin-bottom: 12px;
}

.prose {
	color: var(--text-2);
	font-family: var(--sans);
	font-size: 17px;
	line-height: 1.7;
}

.prose > * + * {
	margin-top: 1.1em;
}

.prose h2,
.prose h3 {
	font-family: var(--display);
	color: var(--text-1);
	line-height: 1.25;
	margin-top: 2em;
}

.prose a {
	color: var(--accent);
}

.prose :not(pre) > code {
	font-family: var(--mono);
	font-size: 0.9em;
	color: var(--text-1);
	background: var(--bg-2);
	padding: 1px 5px;
	border-radius: 3px;
}

.prose ul,
.prose ol {
	padding-left: 1.4em;
}

.prose figure svg {
	display: block;
	width: 100%;
	height: auto;
}

.prose figcaption {
	font-family: var(--mono);
	font-size: 12px;
	color: var(--text-3);
	margin-top: 8px;
}
```

Inline code sits on `--bg-2` (`--panel`) in `--text-1` (`--ink-hi`): 9.35 at night and 9.56 by day.

- [ ] **Step 6: Note the prerender dependency in middleware**

In `apps/website/src/middleware.ts`, replace the existing comment with:

```ts
// While SITE_LAUNCHED is false, only `/` (the coming-soon page) is reachable;
// every other URL bounces back to it. New pages opt out of this by either
// launching (flip the env) or being prerendered (middleware doesn't run for
// static assets served via the Cloudflare ASSETS binding).
//
// /plugins and /blog are public today by the second route, and that is
// deliberate: they show what is real while the hosted product stays behind
// the waitlist. blog-routes.test.ts fails if a blog route stops prerendering.
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @onlooker/website test blog-posts`, then `pnpm --filter @onlooker/website test blog-routes`
Expected: both PASS.

- [ ] **Step 8: Commit**

Through `/git-workflow:commit`, staging every file in this task's list. Suggested subject: `feat(website): publish a blog past the launch gate by prerendering it`.

---

### Task 5: RSS feed

**Files:**
- Modify: `apps/website/src/lib/blog-posts.ts`
- Create: `apps/website/src/pages/blog/rss.xml.ts`
- Test: `apps/website/src/__tests__/blog-posts.test.ts` (extend), `apps/website/src/__tests__/blog-routes.test.ts` (add the feed to the route list)

**Interfaces:**
- Consumes: `publishedPosts()`, `SITE_URL`, `PostLike`.
- Produces: `feedItems(posts: readonly PostLike[]): { title: string; description: string; pubDate: Date; link: string; categories: string[] }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/website/src/__tests__/blog-posts.test.ts` (add `feedItems` to the import, and `import { getRssString } from "@astrojs/rss";` at the top):

```ts
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
			link: "/blog/newer",
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
		const newer = xml.indexOf("<link>https://onlooker.dev/blog/newer</link>");
		const older = xml.indexOf("<link>https://onlooker.dev/blog/older</link>");
		expect(newer).toBeGreaterThan(-1);
		expect(older).toBeGreaterThan(newer);
	});
});
```

In `apps/website/src/__tests__/blog-routes.test.ts`, the feed is a blog route too, so add it to the expected list:

```ts
	it("are the ones the spec names", () => {
		expect(files).toEqual([
			"[slug].astro",
			"index.astro",
			"rss.xml.ts",
			"tags/[tag].astro",
		]);
	});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test blog-posts`, then `pnpm --filter @onlooker/website test blog-routes`
Expected: `blog-posts` FAILS (`feedItems` is not exported). `blog-routes` FAILS on "are the ones the spec names" (`rss.xml.ts` missing).

- [ ] **Step 3: Write the implementation**

Append to `src/lib/blog-posts.ts`:

```ts
/** RSS items in the order given; publishedPosts() has already sorted them. */
export function feedItems(posts: readonly PostLike[]) {
	return posts.map((post) => ({
		title: post.data.title,
		description: post.data.description,
		pubDate: post.data.published,
		link: `/blog/${post.id}`,
		categories: [...post.data.tags],
	}));
}
```

`apps/website/src/pages/blog/rss.xml.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/website test blog-posts`, then `pnpm --filter @onlooker/website test blog-routes`
Expected: both PASS, and `rss.xml.ts` is checked for `prerender = true` like the other routes.

If `getRssString` renders `<link>` with a trailing slash, match the assertion to what it emits, and confirm the same form resolves on the built site in Task 7.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, staging `blog-posts.ts`, `rss.xml.ts`, `blog-posts.test.ts`, `blog-routes.test.ts`. Suggested subject: `feat(website): offer the blog as a feed`.

---

### Task 5a: Name the blog on the launch gate

Added 2026-11-07 after Task 5 found the spec's premise wrong: Astro runs `middleware.ts` while it prerenders, so with `SITE_LAUNCHED` false every page but `/` builds as a "Redirecting to: /" document, blog included. `https://onlooker.dev/plugins/` serves exactly that today. The user chose to name `/blog` on the gate and keep `/plugins` gated until ONL-263 and ONL-264 land.

**Files:**
- Create: `apps/website/src/lib/launch-gate.ts`
- Modify: `apps/website/src/middleware.ts`, `apps/website/src/layouts/Layout.astro`, `apps/website/src/__tests__/layout-meta.test.ts`, `apps/website/src/__tests__/blog-routes.test.ts` (comment only)
- Test: `apps/website/src/__tests__/launch-gate.test.ts`

**Interfaces:**
- Produces: `isPublicBeforeLaunch(pathname: string): boolean` from `src/lib/launch-gate.ts`. ONL-264 will extend it with `/plugins`.

- [ ] **Step 1: Write the failing tests**

`apps/website/src/__tests__/launch-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isPublicBeforeLaunch } from "../lib/launch-gate";

describe("isPublicBeforeLaunch", () => {
	for (const path of [
		"/",
		"/blog",
		"/blog/",
		"/blog/contrast-arena",
		"/blog/contrast-arena/",
		"/blog/tags/measurements",
		"/blog/rss.xml",
	]) {
		it(`lets ${path} through`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(true);
		});
	}

	// /plugins stays behind the gate until its pages match the marketplace
	// (ONL-263); ONL-264 adds it here. /blogx is the prefix match a careless
	// startsWith("/blog") would let through.
	for (const path of ["/plugins", "/plugins/archivist", "/blogx", "/signup", ""]) {
		it(`keeps ${JSON.stringify(path)} behind the gate`, () => {
			expect(isPublicBeforeLaunch(path)).toBe(false);
		});
	}
});
```

In `apps/website/src/__tests__/layout-meta.test.ts`, replace the `Layout nav` block:

```ts
describe("Layout nav", () => {
	it("links the blog", async () => {
		expect(await render({})).toMatch(/<a[^>]*href="\/blog"[^>]*>Blog<\/a>/);
	});

	// /plugins still builds as a redirect to / while the site is unlaunched,
	// so a nav link there would send every reader home. ONL-264 restores it.
	it("does not link the plugin pages yet", async () => {
		expect(await render({})).not.toMatch(/href="\/plugins"/);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test launch-gate`, then `pnpm --filter @onlooker/website test layout-meta`
Expected: `launch-gate` FAILS (cannot resolve `../lib/launch-gate`). `layout-meta` FAILS on "does not link the plugin pages yet".

- [ ] **Step 3: Write the implementation**

`apps/website/src/lib/launch-gate.ts`:

```ts
/**
 * The paths a reader can open while SITE_LAUNCHED is false. Everything else
 * redirects to the coming-soon page.
 *
 * Named rather than inferred. Astro runs middleware while it prerenders, so
 * prerendering a page does not get it past the gate: the page is built as a
 * redirect document instead (measured 2026-11-07, and what
 * onlooker.dev/plugins/ served at the time).
 */
export function isPublicBeforeLaunch(pathname: string): boolean {
	return pathname === "/" || pathname === "/blog" || pathname.startsWith("/blog/");
}
```

`apps/website/src/middleware.ts`, whole file:

```ts
import { SITE_LAUNCHED } from "astro:env/server";
import { defineMiddleware } from "astro:middleware";
import { isPublicBeforeLaunch } from "./lib/launch-gate";

// While SITE_LAUNCHED is false, only the paths launch-gate.ts names are
// reachable, and every other URL bounces to the coming-soon page. This runs
// for prerendered pages too, at build time, so a page is public only if it is
// named there.
export const onRequest = defineMiddleware((context, next) => {
	if (SITE_LAUNCHED || isPublicBeforeLaunch(context.url.pathname)) return next();
	return context.redirect("/", 307);
});
```

In `apps/website/src/layouts/Layout.astro`, delete the line `<a class="nav-link" href="/plugins">Plugins</a>`.

In `apps/website/src/__tests__/blog-routes.test.ts`, replace the comment above `describe("blog routes"` (it states the premise that turned out false) with:

```ts
// The blog is static content, so every route prerenders. That is about cost,
// not reachability: launch-gate.ts decides what is public, and the gate runs
// at build time for prerendered pages as well.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/website test launch-gate`, then `pnpm --filter @onlooker/website test layout-meta`, then `pnpm --filter @onlooker/website test blog-routes`
Expected: all PASS.

- [ ] **Step 5: Prove the fix against a real build, with the gate closed**

```bash
cd apps/website
env -u SITE_LAUNCHED pnpm build
head -c 120 dist/client/blog/index.html; echo
head -c 120 dist/client/blog/rss.xml; echo
head -c 120 dist/client/plugins/index.html; echo
```

Expected: `blog/index.html` is the real page (it contains "Nothing published yet."), `rss.xml` starts with `<?xml`, and `plugins/index.html` still starts with `<!doctype html><title>Redirecting to: /`. Paste all three into the report. Then revert the `isPublicBeforeLaunch` body to `return pathname === "/";`, rebuild, and confirm `blog/index.html` becomes a redirect. Paste that too, restore the body, and rebuild once more.

- [ ] **Step 6: Run every gate and commit**

```bash
pnpm --filter @onlooker/website test
pnpm --filter @onlooker/website typecheck
pnpm --filter @onlooker/website lint
```

Through `/git-workflow:commit`, staging the five files above plus `launch-gate.test.ts`. Suggested subject: `fix(website): name the blog on the launch gate instead of trusting prerender`.

---

### Task 6: The diagram pattern and its first diagram

**Files:**
- Create: `apps/website/src/components/diagrams/ToolCallLedger.astro`
- Test: `apps/website/src/__tests__/diagram-colors.test.ts`

**Interfaces:**
- Produces: `ToolCallLedger` (no props), imported by the Task 7 post.

The diagram shows the first post's central finding. An edit made through the Edit tool fires `PostToolUse` matched on `Edit`, and lineage records `lineage.change.recorded`. The same bytes written by `sed -i` through Bash fire `PostToolUse` matched on `Bash`, which emits only `tool.shell.exec`, so the ledger gets nothing. Both lanes change the file; only one leaves a record.

- [ ] **Step 1: Write the failing tests**

`apps/website/src/__tests__/diagram-colors.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import ToolCallLedger from "../components/diagrams/ToolCallLedger.astro";

const DIR = new URL("../components/diagrams/", import.meta.url);

// Brand text tokens on brand surfaces are already held to 4.5 by the brand
// package and derived-surfaces.test.ts. A diagram inherits that only if it
// uses nothing else, so this is the check that extends the guarantee to it.
const LITERAL =
	/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])|\brgba?\(|\bhsla?\(/i;

describe("diagrams", () => {
	const files = readdirSync(DIR).filter((f) => f.endsWith(".astro"));

	it("exist, so this check is not passing over an empty folder", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file} uses brand variables, not color literals`, () => {
			const source = readFileSync(new URL(file, DIR), "utf8");
			expect(source.match(LITERAL)?.[0] ?? null).toBeNull();
		});
	}

	it("ToolCallLedger tells a screen reader what it shows", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(ToolCallLedger);
		expect(html).toMatch(/<svg[^>]*role="img"/);
		expect(html).toMatch(/<title[^>]*>[^<]+<\/title>/);
		expect(html).toMatch(/<desc[^>]*>[^<]*tool\.shell\.exec[^<]*<\/desc>/);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @onlooker/website test diagram-colors`
Expected: FAIL, cannot resolve `ToolCallLedger.astro`.

- [ ] **Step 3: Write the diagram**

`apps/website/src/components/diagrams/ToolCallLedger.astro`:

```astro
---
// Two edits that move the same bytes, and the one record between them.
// Colors come only from brand variables, so the diagram follows the page's
// theme and inherits the contrast guarantee; diagram-colors.test.ts fails on
// any literal.
---

<figure>
  <svg
    viewBox="0 0 640 250"
    role="img"
    aria-labelledby="tcl-title tcl-desc"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title id="tcl-title">An Edit leaves a lineage record; the same change through Bash leaves none</title>
    <desc id="tcl-desc">
      Top lane: the Edit tool changes a file, PostToolUse fires matched on Edit,
      and lineage writes lineage.change.recorded to the ledger. Bottom lane: sed -i
      through the Bash tool changes the same file, PostToolUse fires matched on
      Bash, only tool.shell.exec is emitted, and the ledger gets nothing.
    </desc>

    <defs>
      <marker id="tcl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" class="tcl-head" />
      </marker>
    </defs>

    <g class="tcl-lane">
      <text x="0" y="22" class="tcl-label">Edit tool</text>
      <rect x="0" y="34" width="150" height="56" rx="6" class="tcl-box" />
      <text x="75" y="67" class="tcl-text" text-anchor="middle">Edit file.ts</text>

      <line x1="150" y1="62" x2="232" y2="62" class="tcl-line" marker-end="url(#tcl-arrow)" />
      <rect x="235" y="34" width="170" height="56" rx="6" class="tcl-box" />
      <text x="320" y="58" class="tcl-text" text-anchor="middle">PostToolUse</text>
      <text x="320" y="77" class="tcl-small" text-anchor="middle">matcher: Edit</text>

      <line x1="405" y1="62" x2="467" y2="62" class="tcl-line" marker-end="url(#tcl-arrow)" />
      <rect x="470" y="34" width="170" height="56" rx="6" class="tcl-box tcl-hit" />
      <text x="555" y="58" class="tcl-text" text-anchor="middle">ledger</text>
      <text x="555" y="77" class="tcl-small tcl-ok" text-anchor="middle">change.recorded</text>
    </g>

    <g class="tcl-lane">
      <text x="0" y="152" class="tcl-label">Bash tool</text>
      <rect x="0" y="164" width="150" height="56" rx="6" class="tcl-box" />
      <text x="75" y="197" class="tcl-text" text-anchor="middle">sed -i file.ts</text>

      <line x1="150" y1="192" x2="232" y2="192" class="tcl-line" marker-end="url(#tcl-arrow)" />
      <rect x="235" y="164" width="170" height="56" rx="6" class="tcl-box" />
      <text x="320" y="188" class="tcl-text" text-anchor="middle">PostToolUse</text>
      <text x="320" y="207" class="tcl-small" text-anchor="middle">matcher: Bash</text>

      <line x1="405" y1="192" x2="467" y2="192" class="tcl-line tcl-dashed" marker-end="url(#tcl-arrow)" />
      <rect x="470" y="164" width="170" height="56" rx="6" class="tcl-box tcl-miss" />
      <text x="555" y="188" class="tcl-text" text-anchor="middle">ledger</text>
      <text x="555" y="207" class="tcl-small tcl-bad" text-anchor="middle">no record</text>
    </g>

    <text x="320" y="244" class="tcl-small" text-anchor="middle">Bash emits tool.shell.exec only</text>
  </svg>
  <figcaption>Both lanes change file.ts. Only the top one is on the record.</figcaption>
</figure>

<style>
  .tcl-box { fill: var(--panel); stroke: var(--edge); stroke-width: 1.5; }
  .tcl-hit { stroke: var(--teal); }
  .tcl-miss { stroke: var(--red); stroke-dasharray: 5 4; }
  .tcl-line { stroke: var(--ink-dim); stroke-width: 1.5; }
  .tcl-dashed { stroke-dasharray: 5 4; }
  .tcl-head { fill: var(--ink-dim); }
  .tcl-label { fill: var(--ink-dim); font-family: var(--font-data); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
  .tcl-text { fill: var(--ink-hi); font-family: var(--font-data); font-size: 14px; }
  .tcl-small { fill: var(--ink); font-family: var(--font-data); font-size: 12px; }
  .tcl-ok { fill: var(--teal); }
  .tcl-bad { fill: var(--red); }
</style>
```

Text on `--panel` uses `--ink-hi`, `--ink`, `--teal` and `--red`, all ≥4.67 there in both themes. `--ink-dim` labels sit on `--ground`.

- [ ] **Step 4: Run the tests to verify they pass, then ablate**

Run: `pnpm --filter @onlooker/website test diagram-colors`
Expected: PASS.

Temporarily change `fill: var(--panel)` in `.tcl-box` to `fill: #464074` and run again. Expected: the literal test FAILS and names `#464074`. Restore it and confirm PASS.

- [ ] **Step 5: Commit**

Through `/git-workflow:commit`, staging `ToolCallLedger.astro`, `diagram-colors.test.ts`. Suggested subject: `feat(website): draw diagrams only in brand colors`.

---

### Task 7: The first post, and proof that the whole thing ships

**Files:**
- Create: `apps/website/src/content/blog/contrast-arena.mdx`
- Delete: `apps/website/src/content/blog/.gitkeep`

This task is writing, and **the user signs off on the prose before it's published.** An agent drafts; it does not flip `draft` to `false` on its own.

- [ ] **Step 1: Read the sources**

Everything the post claims comes from these, and each number is cited the way the specs cite their own:

- `docs/superpowers/specs/2026-08-30-marketplace-contrast-arena-design.md`
- `bd show onlooker-12s` (its NOTES hold the propagated findings and the 176ms/178ms corroboration)
- PRs #235 and #238 (`gh pr view 235`, `gh pr view 238`), which recorded the arena findings
- CLAUDE.md, "Edit tracked files with the file tools, not the shell": the 348-record ledger breakdown (108 `Write`, 240 `Edit`, nothing from any shell tool), measured 2026-08-30

- [ ] **Step 2: Draft the post with `draft: true`**

`apps/website/src/content/blog/contrast-arena.mdx` starts with:

```mdx
---
title: "Running Onlooker's plugins on the repo that isn't theirs"
description: "We pointed the plugin stack at a TypeScript monorepo instead of its own bash repository, and the most useful finding was a record that wasn't there."
published: 2026-11-07
tags: ["measurements", "building-onlooker"]
draft: true
---

import ToolCallLedger from "../../components/diagrams/ToolCallLedger.astro";
```

Sections, in order:

1. **Why a second arena.** The marketplace was being dogfooded on the ecosystem repo, which is bash. This repo is a pnpm/turbo TypeScript monorepo, so it surfaces what the home repo can't. Say why the gates were excluded (production deploys and D1 migrations live here).
2. **What we measured.** Which plugins, from committed settings, verified present in hook-health first.
3. **The record that wasn't there.** lineage and inspector observe tool calls, not filesystem changes. Show `<ToolCallLedger />` here. Give the 348-record breakdown and what it costs: `/lineage file:line` answers "no record" for a line that was demonstrably written.
4. **What else turned up.** The echo `watch_paths` no-op, and inspector's 221ms to decide it had nothing to run.
5. **What held.** The Bash round trip at 176ms against ecosystem's 178ms, as independent evidence the instrument is sound.
6. **What changed because of it.** The file-tools editing rule in this repo, and the findings filed upstream to the repo that ships the fix.

Include at least one fenced code block (the CLAUDE.md rule, or a hook matcher from `.claude/settings.json`), so the post exercises the Task 3 theming.

- [ ] **Step 3: Read it rendered**

```bash
pnpm --filter @onlooker/website dev
```

Open `http://localhost:4321/blog` and `http://localhost:4321/blog/contrast-arena`. Check:

- the draft appears in dev
- the diagram and code block switch with the theme: toggle `data-theme="light"` on `<html>` in devtools
- nothing scrolls the page sideways at 360px width
- the tag links go to `/blog/tags/measurements` and `/blog/tags/building-onlooker`

Then run the post through `/avoid-ai-writing` in detect mode and fix what it flags.

- [ ] **Step 4: Hand the draft to the user**

Stop and ask the user to read the rendered post. Apply their edits. Do not continue until they approve the text.

- [ ] **Step 5: Prove the draft filter end to end, against a real build**

With the post still `draft: true`:

```bash
pnpm --filter @onlooker/website build
find apps/website/dist -path '*blog*' -name '*.html' | sort
grep -c "<item>" apps/website/dist/client/blog/rss.xml
```

Expected: no `contrast-arena` page in the list; `/blog/index.html` contains "Nothing published yet."; the feed has 0 items. (If the built files land somewhere other than `dist/client/`, use the path `find` printed.)

- [ ] **Step 6: Publish**

Set `draft: false` and set `published` to the date of this change, then delete `.gitkeep`. Rebuild:

```bash
pnpm --filter @onlooker/website build
find apps/website/dist -path '*blog*' -name '*.html' | sort
grep -c "<item>" apps/website/dist/client/blog/rss.xml
```

Expected: `blog/index.html`, `blog/contrast-arena/index.html`, `blog/tags/measurements/index.html`, `blog/tags/building-onlooker/index.html`, and 1 feed item linking `https://onlooker.dev/blog/contrast-arena`.

- [ ] **Step 7: Run every gate**

```bash
pnpm --filter @onlooker/website test
pnpm --filter @onlooker/website typecheck
pnpm --filter @onlooker/website lint
```

Expected: all pass.

- [ ] **Step 8: Commit**

Through `/git-workflow:commit`, staging `contrast-arena.mdx` and the `.gitkeep` deletion. Suggested subject: `docs(website): publish the contrast arena as the first post`.

---

### Task 8: Hand off

- [ ] **Step 1: Close the child beads, and add a note on the parent** recording the verification output from Task 7, Steps 5–7: `bd update <bead-id> --append-notes "..."`.
- [ ] **Step 2: Ask the user before opening a PR.** On a yes, use `/git-workflow:pr`. A merge deploys straight to onlooker.dev (no staging), so the PR description should say what ships publicly: `/blog`, its tag pages, the feed, the first post, a nav link to `/blog`, and the launch gate's new allowlist. It should also say that `/plugins` stays gated (ONL-263, ONL-264).
