# Marketing Blog — Design

Linear: ONL-259. Related: ONL-257 (PR preview deploys), ONL-37 (the first
post's subject).

**onlooker.dev gets a blog at `/blog`: MDX posts in the repo, tagged for a mixed
audience, drawn in the brand's own tokens, and prerendered so it ships while the
rest of the site stays behind the waitlist.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-07.
Sections marked *(measured)* were read from this repository on 2026-11-07.

## Where the site is today *(measured)*

* `/` is a waitlist page: "Coming Soon", an email form posting to formsubmit.co,
  and six pills. Two of the pills, "Waypoint hint engine" and "Shared
  Playbooks", name nothing that ships under those names.
* `/plugins` and `/plugins/[slug]` exist and are prerendered, but nothing links
  to them. The nav holds the logo and an "Early Access" tag only.
* `src/middleware.ts` redirects every path except `/` to `/` while
  `SITE_LAUNCHED` is false (its default). Middleware does not run for
  prerendered pages served from the `ASSETS` binding, so a prerendered page
  is public regardless of the flag. That is how `/plugins` is live.
* `Layout.astro` sets `og:title` to "Onlooker" on every page and has no
  canonical URL.
* `astro.config.mjs` sets no `site`, which RSS and canonical URLs both need.
* `derived-surfaces.test.ts` checks contrast for every surface `globals.css`
  derives from the brand tokens, because `@onlooker/brand`'s own guarantee
  stops at the two surfaces it defines.
* The site has no staging environment. A merge to main deploys to production.

## Decisions *(approved)*

**The hosted product isn't open to strangers yet.** The site stays a waitlist
for the hosted side but shows what is real. The blog is the first piece of
that, and the landing page rewrite is the next spec.

**One stream, tagged.** The audience is a mix: Claude Code users, engineers
interested in how Onlooker is built, and prospective plugin authors. Posts carry
tags instead of living in separate sections.

**Drafts are local only.** A draft renders under `astro dev` and is absent from
every production build. Preview URLs per PR are ONL-257.

**Diagrams are hand-made inline SVG components** that read brand variables.
Mermaid's generic look would clash with the 16-bit identity, and its build-time
rendering needs a headless browser in CI.

**No per-post OG images.** Posts share the site's OG image for now.

**The blog ships with one post,** on the contrast-arena measurement, so the nav
never links to an empty page.

## Content model

Posts live in `apps/website/src/content/blog/<slug>.mdx`, loaded by a `glob`
collection in `src/content.config.ts`. The file name is the slug.

```ts
const blog = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),   // one sentence: meta description, OG, index card
    published: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.enum(TAGS)).min(1),
    draft: z.boolean().default(false),
    author: z.string().default("Meagan Waller"),
  }),
});
```

`TAGS` is a closed list, exported from `src/data/blog.ts` so pages and tests
share it, together with one function that returns the posts a build should
publish:

```ts
export const TAGS = [
  "architecture",
  "plugins",
  "building-onlooker",
  "measurements",
  "marketplace",
] as const;

/** Pure, so it is testable without Astro's runtime. */
export function selectPublished<T extends { data: { draft: boolean; published: Date } }>(
  posts: T[],
  production: boolean,
): T[] {
  return posts
    .filter((p) => !production || !p.data.draft)
    .sort((a, b) => b.data.published.valueOf() - a.data.published.valueOf());
}

export async function publishedPosts() {
  return selectPublished(await getCollection("blog"), import.meta.env.PROD);
}
```

A typo in a tag fails the build instead of making a tag with one post. Adding a
tag is a one-line change to `TAGS`.

Every page, the RSS feed and the tag routes get their posts from
`publishedPosts()`. Nothing calls `getCollection("blog")` directly, so the draft
filter exists in exactly one place.

## Routes

All of them set `export const prerender = true`.

| Route | File | Shows |
| --- | --- | --- |
| `/blog` | `src/pages/blog/index.astro` | every published post, newest first: title, date, description, tags |
| `/blog/<slug>` | `src/pages/blog/[slug].astro` | the post |
| `/blog/tags/<tag>` | `src/pages/blog/tags/[tag].astro` | the index filtered to one tag; only tags with a published post get a page |
| `/blog/rss.xml` | `src/pages/blog/rss.xml.ts` | `@astrojs/rss`, every published post |

With no published posts, `/blog` renders one line saying nothing has been
published yet.

`middleware.ts` gains a comment naming `/blog` alongside `/plugins` as pages that
are public because they are prerendered, so nobody "fixes" the gap by moving
them to server rendering.

## Rendering

**Post layout.** `src/layouts/BlogPost.astro` wraps `Layout.astro`, so the nav,
footer and tokens stay shared. A reading column of about 68ch holds the title,
the published date, an "Updated" date when set, and tag links. Body text uses
`--font-body`, headings `--font-display`, inline code `--font-data`. No sidebar
and no table of contents.

**Code blocks.** `markdown.shikiConfig.theme` is `css-variables`. Every
`--astro-code-*` property the theme emits (`--astro-code-foreground`,
`--astro-code-background`, and each `--astro-code-token-*`) is defined in
`globals.css` from brand tokens, so code switches themes with the page. Long
lines scroll inside the block, not the page.

**Diagrams.** One Astro component per diagram in `src/components/diagrams/`,
imported by the post that uses it. Fills, strokes and text use brand variables
only: no hex, no `rgb()`. Each `<svg>` has `role="img"`, a `<title>`, and a
`<desc>` that states the mechanism the picture shows. It scales to the column
width and stays legible at 360px.

**Meta.** `Layout.astro` takes optional `ogType` (default `website`),
`publishedTime` and `canonicalPath` props. It emits `og:title` from the page
title, `og:url` and `<link rel="canonical">` from `site` plus the path, and
`article:published_time` when given. `astro.config.mjs` sets
`site: "https://onlooker.dev"`. `Layout.astro` also links the feed with
`<link rel="alternate" type="application/rss+xml">`.

**Navigation.** The nav gains **Blog** and **Plugins** links before the "Early
Access" tag, which also fixes the orphaned plugin pages. Nothing else in the nav
changes.

## Dependencies

`@astrojs/mdx` and `@astrojs/rss`, at versions compatible with `astro@^6.3.3`,
declared the same way `package.json` declares `@astrojs/cloudflare`.

## Testing

All in `apps/website/src/__tests__/`, with vitest.

* **Drafts stay out of production.** `selectPublished(fixtures, true)` over one
  draft and one published post returns only the published one, and
  `selectPublished(fixtures, false)` returns both. Prove it by ablation: with
  the filter removed, the first assertion must fail.
* **The schema refuses bad frontmatter.** An unknown tag, an empty tag list and
  a missing description each fail to parse.
* **Every blog route is prerendered.** Read each file under `src/pages/blog/`
  and assert that it exports `prerender = true`. That is what keeps the blog
  past `SITE_LAUNCHED`.
* **Code and diagram colors hold contrast.** `derived-surfaces.test.ts` grows
  to check each `--astro-code-token-*` and `--astro-code-foreground` against
  `--astro-code-background` at 4.5, day and night.
* **Diagrams use only brand variables.** A test scans `src/components/diagrams/`
  and fails on any hex, `rgb(` or `hsl(` literal. Brand text tokens on brand
  surfaces are already covered by the brand package and
  `derived-surfaces.test.ts`, so this check is what extends that guarantee to
  diagrams.
* **The feed is right.** The RSS output parses, lists exactly the published
  posts, newest first, with absolute links under `https://onlooker.dev`.

`pnpm --filter @onlooker/website typecheck` covers the frontmatter types through
`astro check`.

## The first post

"The onlooker repo as a contrast arena". It covers what ONL-37 measured: the
plugin stack run against a TypeScript monorepo rather than its own bash
repository, what that showed, and what it cost. The source is
`docs/superpowers/specs/2026-08-30-marketplace-contrast-arena-design.md` and the
measurements recorded on ONL-37. It has one diagram, the hook-to-ledger flow, which also
exercises the diagram pattern. Tags: `measurements`, `building-onlooker`.

The post is writing work and lands last, on top of the infrastructure.
Everything it claims comes from a measurement in those sources, cited the way
the specs cite their own.

## Out of scope

* Rewriting the landing page and its stale pills (the next spec).
* Plugin catalog drift (`echo` retired, `customs` missing, Archivist's page
  describing compaction), and generating the catalog from the marketplace.
* Per-post OG images.
* PR preview deploys (ONL-257).
* Comments, search, a newsletter, analytics beyond the existing Sentry setup.
