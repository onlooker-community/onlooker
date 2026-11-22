# Weekly Changelog on onlooker.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a weekly changelog at onlooker.dev/changelog: one MDX entry per week, an index, a page per week and an RSS feed. Publish the Nov 14 to 20, 2026 entry, and add `pnpm changelog:new` to scaffold the next one.

**Architecture:** A second content collection, `changelog`, in the Astro website app (`apps/website`), built the way the blog is. A pure lib (`src/lib/changelog-entries.ts`) holds the schema, the closed set of section headings, the draft and sort rules, and the checks that fail the build. One data loader (`src/data/changelog.ts`) is the only reader of the collection, so every page gets the draft filter. Pages are prerendered and added to the launch gate's allowlist.

**Tech Stack:** Astro 6 with MDX and `@astrojs/rss`, zod from `astro/zod`, vitest with `experimental_AstroContainer`, biome, and tsx for the root script.

**Sources:**
- Linear ONL-302, bead `onlooker-xuaps1`. Branch `meagan/onl-302-onlookerdev-has-nowhere-to-say-what-changed`.
- The plan doc "Onlooker changelog plan" (Claude Doc, Nov 20, 2026), which sets the entry format, headings and flow.
- The doc "Onlooker changelog, Nov 14 to 20, 2026", which is the first entry's text.

## Global Constraints

- **Routes:** `/changelog/`, `/changelog/<weekEnd>/` (for example `/changelog/2026-11-20/`) and `/changelog/rss.xml`. Every route file sets `export const prerender = true;`.
- **Launch gate:** all three are public before launch, in `isPublicBeforeLaunch` (`src/lib/launch-gate.ts`). `/changelogx` stays behind the gate.
- **One file per week,** named for the week's last day: `src/content/changelog/<weekEnd>.mdx`. Weeks run Saturday to Friday, and `weekStart` is exactly 6 days before `weekEnd`.
- **Frontmatter:** `title`, `weekStart`, `weekEnd`, `summary`, optional `plugins: [{ name, version }]`, and `draft`. `plugins[].name` must be a plugin with a page on the site.
- **Section headings** form a closed set and appear in this order: `Plugins`, `onlooker.dev`, `Hosted feed`, `Reliability`, `Behind the scenes`. An unknown, repeated or out-of-order heading fails the build. So does an empty section in a published entry. Drafts may have empty sections.
- **Drafts never reach a production build.** Reuse `dropsDrafts` from `src/lib/blog-posts.ts`, so drafts show under `astro dev` and in PR previews (`PREVIEW_DRAFTS`) as blog drafts do.
- **Paths end in a slash,** as `postPath` explains.
- **No new colors.** The new pages use the existing global classes (`prose-page`, `page-header`, `eyebrow`, `breadcrumb`, `prose`, `post-header`, `post-meta`, `post-list`, `post-item`, `post-title`, `post-description`, `post-empty`, `post-tags`). That keeps the token contrast checks in force without changes.
- **Plugin versions** come from each plugin's own `CHANGELOG.md` in the ecosystem repo, never the root CHANGELOG (ONL-175).
- **Copy and code:** American English.
- **Editing:** tracked files change only through the Edit/Write tools. Never run a shell formatter (`biome check --write`, `lint:fix`, `format`). If biome reports formatting, fix it with Edit.
- **Tests:** run one file with `pnpm --filter @onlooker/website test <name>`, with no `--`. Typecheck is `pnpm --filter @onlooker/website typecheck`, lint is `pnpm --filter @onlooker/website lint`. Use `pnpm exec` rather than `npx`, which a hook blocks.
- **Commits:** through `/git-workflow:commit`, or its contract: `<type>(<scope>): <subject> :emoji:` with a why-focused body, staging files by name, and never staging `SESSION_HANDOFF.md`.

## Decisions this plan makes beyond the plan doc

- **No `posts` frontmatter field.** The plan doc lists one ("optional blog slugs to link"), but nothing reads it, and an entry links a post from its body, as the first entry does. Add the field when a page needs it.
- **The section checks run in the entry page's `getStaticPaths`,** not in the zod schema. A zod schema sees frontmatter, not the body. A throw in `getStaticPaths` stops the build, which a throw mid-render does not (see `undefinedTermIds`). The "6 days apart" rule is frontmatter-only, so it lives in the schema.
- **The plugin releases show as chips** under the entry's header, each linking to `/plugins/<name>/` and reusing `post-tags`. A heading for them would collide with the body's `## Plugins`.
- **"Latest update" goes on the landing page,** under "Latest post". The plan doc says "beside the footer's Latest post", but that line is on the home page, not in the footer. To avoid a second copy of its styles, `LatestPost.astro` becomes `LatestLink.astro`, which takes a label, and the home page renders one for each.
- **The footer gains a Changelog link,** as ONL-302's "Done when" asks. The blog stays out of the footer, as it is today.
- **`pnpm changelog:new` scaffolds the week holding today,** Saturday to Friday. It writes four headings and leaves out `Hosted feed`, which the plan doc marks "once it opens". It refuses to overwrite an existing file.
- **The first entry's versions** are the releases that carry the lock fix (#614), dated 2026-11-19: bursar 0.9.6, cartographer 0.13.6, counsel 0.13.5, governor 0.8.5, historian 0.13.6, inspector 0.11.2, lineage 0.10.5 and scribe 0.11.5. The plan doc's "lineage 0.12.4" was an example.

## File Structure

- Create `apps/website/src/lib/changelog-entries.ts`: the schema, `SECTIONS`, `isoDay`, `formatWeek`, `entryPath`, `selectPublishedEntries`, `entryFeedItems`, `sectionProblems` and `entryProblems`. Pure.
- Create `apps/website/src/lib/changelog-scaffold.ts`: `weekOf` and `scaffold`. Pure.
- Create `apps/website/scripts/changelog-new.ts`: the CLI wrapper.
- Modify the root `package.json`: add the `changelog:new` script.
- Modify `apps/website/src/content.config.ts`: add the `changelog` collection.
- Create `apps/website/src/data/changelog.ts`: `publishedEntries()`.
- Create `apps/website/src/components/changelog/EntryList.astro` and `PluginReleases.astro`.
- Create `apps/website/src/layouts/ChangelogEntry.astro`.
- Create `apps/website/src/pages/changelog/index.astro`, `[slug].astro` and `rss.xml.ts`.
- Create `apps/website/src/content/changelog/2026-11-20.mdx`.
- Modify `apps/website/src/lib/launch-gate.ts`.
- Modify `apps/website/src/layouts/Layout.astro`: the nav link, the footer link and the feed `<link rel="alternate">`.
- Rename `apps/website/src/components/blog/LatestPost.astro` to `apps/website/src/components/LatestLink.astro` and generalize it.
- Modify `apps/website/src/pages/index.astro`.
- Tests:
  - Create `apps/website/src/__tests__/changelog-entries.test.ts`, `changelog-routes.test.ts` and `changelog-scaffold.test.ts`.
  - Modify `apps/website/src/__tests__/launch-gate.test.ts` and `layout-meta.test.ts`.
  - Rename `apps/website/src/__tests__/latest-post.test.ts` to `latest-link.test.ts`.

---

### Task 1: The changelog's rules, as a pure lib

**Files:**
- Create: `apps/website/src/lib/changelog-entries.ts`
- Create: `apps/website/src/__tests__/changelog-entries.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `SECTIONS`: a readonly tuple of the five headings, in order.
  - `entrySchema`: the zod schema.
  - `type EntryData = z.infer<typeof entrySchema>`
  - `type EntryLike = { id: string; body?: string; data: EntryData }`
  - `isoDay(d: Date): string`: returns `"YYYY-MM-DD"` in UTC.
  - `formatWeek(start: Date, end: Date): string`
  - `entryPath(id: string): string`
  - `selectPublishedEntries<T>(entries: readonly T[], dropDrafts: boolean): T[]`: newest `weekEnd` first.
  - `entryFeedItems(entries: readonly EntryLike[])`
  - `sectionProblems(body: string, draft: boolean): string[]`
  - `entryProblems(entry: EntryLike, knownPlugins: ReadonlySet<string>): string[]`: each problem is prefixed with `<id>: `.

- [ ] **Step 1: Write the failing test**

Create `apps/website/src/__tests__/changelog-entries.test.ts`:

```ts
import { getRssString } from "@astrojs/rss";
import { describe, expect, it } from "vitest";
import {
	entryFeedItems,
	entryPath,
	entryProblems,
	entrySchema,
	formatWeek,
	isoDay,
	SECTIONS,
	sectionProblems,
	selectPublishedEntries,
} from "../lib/changelog-entries";

const valid = {
	title: "A week",
	weekStart: "2026-11-14",
	weekEnd: "2026-11-20",
	summary: "What changed.",
};

const parsed = (over: Record<string, unknown> = {}) =>
	entrySchema.parse({ ...valid, ...over });

const BODY = [
	"## Plugins",
	"",
	"- **A fix.** Why it matters.",
	"",
	"## Reliability",
	"",
	"- **Another.** Why.",
	"",
].join("\n");

describe("entrySchema", () => {
	it("accepts a minimal entry and fills the defaults", () => {
		const data = parsed();
		expect(data.draft).toBe(false);
		expect(data.plugins).toEqual([]);
		expect(data.weekEnd).toEqual(new Date("2026-11-20"));
	});

	it("takes plugin versions", () => {
		expect(
			parsed({ plugins: [{ name: "lineage", version: "0.10.5" }] }).plugins,
		).toEqual([{ name: "lineage", version: "0.10.5" }]);
	});

	it("refuses a version that is not x.y.z", () => {
		expect(() =>
			parsed({ plugins: [{ name: "lineage", version: "v0.10" }] }),
		).toThrow();
	});

	it("refuses an entry with no summary", () => {
		expect(() => parsed({ summary: "" })).toThrow();
	});

	// A week is Saturday to Friday: seven days, the last six after the first.
	it("refuses a week that is not seven days long", () => {
		expect(() => parsed({ weekStart: "2026-11-13" })).toThrow(
			/six days after weekStart/,
		);
	});
});

describe("SECTIONS", () => {
	it("is the closed set, in order", () => {
		expect(SECTIONS).toEqual([
			"Plugins",
			"onlooker.dev",
			"Hosted feed",
			"Reliability",
			"Behind the scenes",
		]);
	});
});

describe("formatWeek", () => {
	const d = (s: string) => new Date(s);

	it("names the month once inside one month", () => {
		expect(formatWeek(d("2026-11-14"), d("2026-11-20"))).toBe(
			"November 14 to 20, 2026",
		);
	});

	it("names both months across a month", () => {
		expect(formatWeek(d("2026-11-28"), d("2026-12-04"))).toBe(
			"November 28 to December 4, 2026",
		);
	});

	it("names both years across a year", () => {
		expect(formatWeek(d("2026-12-26"), d("2027-01-01"))).toBe(
			"December 26, 2026 to January 1, 2027",
		);
	});
});

describe("isoDay and entryPath", () => {
	it("gives the frontmatter day back", () => {
		expect(isoDay(new Date("2026-11-20"))).toBe("2026-11-20");
	});

	it("ends an entry path in a slash", () => {
		expect(entryPath("2026-11-20")).toBe("/changelog/2026-11-20/");
	});
});

describe("selectPublishedEntries", () => {
	const entry = (id: string, weekEnd: string, draft: boolean) => ({
		id,
		data: { weekEnd: new Date(weekEnd), draft },
	});
	const entries = [
		entry("older", "2026-11-13", false),
		entry("draft", "2026-11-27", true),
		entry("newer", "2026-11-20", false),
	];

	it("leaves drafts out when asked, newest week first", () => {
		expect(selectPublishedEntries(entries, true).map((e) => e.id)).toEqual([
			"newer",
			"older",
		]);
	});

	it("keeps drafts otherwise, still newest first", () => {
		expect(selectPublishedEntries(entries, false).map((e) => e.id)).toEqual([
			"draft",
			"newer",
			"older",
		]);
	});

	it("does not reorder its input in place", () => {
		selectPublishedEntries(entries, false);
		expect(entries.map((e) => e.id)).toEqual(["older", "draft", "newer"]);
	});
});

describe("sectionProblems", () => {
	it("passes known sections in order", () => {
		expect(sectionProblems(BODY, false)).toEqual([]);
	});

	it("names an unknown heading", () => {
		expect(sectionProblems("## Plugin\n\n- x\n", false)).toEqual([
			'unknown section "Plugin"; use one of: Plugins, onlooker.dev, Hosted feed, Reliability, Behind the scenes',
		]);
	});

	it("names a heading out of order", () => {
		expect(
			sectionProblems("## Reliability\n\n- x\n\n## Plugins\n\n- y\n", false),
		).toEqual([
			'section "Plugins" is out of order; the order is Plugins, onlooker.dev, Hosted feed, Reliability, Behind the scenes',
		]);
	});

	it("names a heading used twice", () => {
		expect(
			sectionProblems("## Plugins\n\n- x\n\n## Plugins\n\n- y\n", false),
		).toEqual(['section "Plugins" appears twice']);
	});

	// An MDX comment is what changelog:new leaves in each section.
	it("refuses an empty section in a published entry", () => {
		expect(
			sectionProblems(
				"## Plugins\n\n{/* write here */}\n\n## Reliability\n\n- x\n",
				false,
			),
		).toEqual(['section "Plugins" is empty; leave it out']);
	});

	it("allows empty sections in a draft", () => {
		expect(sectionProblems("## Plugins\n\n{/* write here */}\n", true)).toEqual(
			[],
		);
	});

	it("needs at least one section in a published entry", () => {
		expect(sectionProblems("Just prose.\n", false)).toEqual([
			"a published entry needs at least one section",
		]);
	});

	it("ignores ## lines inside a code fence", () => {
		expect(
			sectionProblems(
				"## Plugins\n\n```md\n## Not a section\n```\n",
				false,
			),
		).toEqual([]);
	});

	it("leaves ### subheadings alone", () => {
		expect(sectionProblems("## Plugins\n\n### lineage\n\n- x\n", false)).toEqual(
			[],
		);
	});
});

describe("entryProblems", () => {
	const known = new Set(["lineage", "bursar"]);

	it("passes a well-formed entry", () => {
		expect(
			entryProblems(
				{ id: "2026-11-20", body: BODY, data: parsed() },
				known,
			),
		).toEqual([]);
	});

	it("names a file that doesn't match its weekEnd", () => {
		expect(
			entryProblems({ id: "2026-11-21", body: BODY, data: parsed() }, known),
		).toEqual([
			"2026-11-21: the file is named 2026-11-21 but weekEnd is 2026-11-20; name it 2026-11-20.mdx",
		]);
	});

	it("names a plugin with no page", () => {
		expect(
			entryProblems(
				{
					id: "2026-11-20",
					body: BODY,
					data: parsed({ plugins: [{ name: "lineag", version: "1.0.0" }] }),
				},
				known,
			),
		).toEqual(['2026-11-20: plugins: no plugin page for "lineag"']);
	});

	it("prefixes section problems with the entry id", () => {
		expect(
			entryProblems(
				{ id: "2026-11-20", body: "## Plugin\n\n- x\n", data: parsed() },
				known,
			)[0],
		).toMatch(/^2026-11-20: unknown section "Plugin"/);
	});
});

describe("the feed", () => {
	const entries = [
		{ id: "2026-11-20", data: parsed() },
		{
			id: "2026-11-13",
			data: parsed({
				title: "Older",
				weekStart: "2026-11-07",
				weekEnd: "2026-11-13",
			}),
		},
	];

	it("carries each entry's title, summary, week end and path", () => {
		expect(entryFeedItems(entries)[0]).toEqual({
			title: "A week",
			description: "What changed.",
			pubDate: new Date("2026-11-20"),
			link: "/changelog/2026-11-20/",
		});
	});

	it("renders absolute links under onlooker.dev, in the order given", async () => {
		const xml = await getRssString({
			title: "Onlooker changelog",
			description: "test",
			site: "https://onlooker.dev",
			items: entryFeedItems(entries),
		});
		const newer = xml.indexOf(
			"<link>https://onlooker.dev/changelog/2026-11-20/</link>",
		);
		const older = xml.indexOf(
			"<link>https://onlooker.dev/changelog/2026-11-13/</link>",
		);
		expect(newer).toBeGreaterThan(-1);
		expect(older).toBeGreaterThan(newer);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/website test changelog-entries`
Expected: FAIL, because `../lib/changelog-entries` can't be resolved.

- [ ] **Step 3: Write the implementation**

Create `apps/website/src/lib/changelog-entries.ts`:

```ts
import { z } from "astro/zod";

// Pure, like blog-posts.ts and for the same reason: vitest runs without
// astro:content, so the rules a test checks have to live outside it.

/** The headings an entry may use, in the order it must use them (ONL-302). */
export const SECTIONS = [
	"Plugins",
	"onlooker.dev",
	"Hosted feed",
	"Reliability",
	"Behind the scenes",
] as const;

const DAY_MS = 86_400_000;

export const entrySchema = z
	.object({
		title: z.string().min(1),
		weekStart: z.coerce.date(),
		weekEnd: z.coerce.date(),
		summary: z.string().min(1),
		// Versions from each plugin's own CHANGELOG.md, never the root one,
		// which can carry duplicates (ONL-175).
		plugins: z
			.array(
				z.object({
					name: z.string().min(1),
					version: z.string().regex(/^\d+\.\d+\.\d+$/),
				}),
			)
			.default([]),
		draft: z.boolean().default(false),
	})
	.refine(
		(d) => d.weekEnd.valueOf() - d.weekStart.valueOf() === 6 * DAY_MS,
		{ message: "weekEnd must be six days after weekStart", path: ["weekEnd"] },
	);

export type EntryData = z.infer<typeof entrySchema>;

export type EntryLike = { id: string; body?: string; data: EntryData };

/** A frontmatter date back as the day it names, "2026-11-20". */
export function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

const MONTH = new Intl.DateTimeFormat("en-US", {
	month: "long",
	timeZone: "UTC",
});

/** "November 14 to 20, 2026", naming a month or year again only when it changes. */
export function formatWeek(start: Date, end: Date): string {
	const [sm, em] = [MONTH.format(start), MONTH.format(end)];
	const [sd, ed] = [start.getUTCDate(), end.getUTCDate()];
	const [sy, ey] = [start.getUTCFullYear(), end.getUTCFullYear()];
	if (sy !== ey) return `${sm} ${sd}, ${sy} to ${em} ${ed}, ${ey}`;
	if (sm !== em) return `${sm} ${sd} to ${em} ${ed}, ${ey}`;
	return `${sm} ${sd} to ${ed}, ${ey}`;
}

// With the slash, for the reason postPath gives.
export function entryPath(id: string): string {
	return `/changelog/${id}/`;
}

/** The entries a build publishes, newest week first. */
export function selectPublishedEntries<
	T extends { data: { draft: boolean; weekEnd: Date } },
>(entries: readonly T[], dropDrafts: boolean): T[] {
	return entries
		.filter((e) => !dropDrafts || !e.data.draft)
		.sort((a, b) => b.data.weekEnd.valueOf() - a.data.weekEnd.valueOf());
}

/** RSS items in the order given; publishedEntries() has already sorted them. */
export function entryFeedItems(entries: readonly EntryLike[]) {
	return entries.map((entry) => ({
		title: entry.data.title,
		description: entry.data.summary,
		pubDate: entry.data.weekEnd,
		link: entryPath(entry.id),
	}));
}

const FENCE = /^(```|~~~)/;
const HEADING = /^##\s+(.+?)\s*$/;
// What changelog:new leaves in each section. It renders as nothing.
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

/**
 * What is wrong with an entry body's `##` headings. A zod schema sees only
 * frontmatter, so the entry page's getStaticPaths runs this, where a throw
 * stops the build (see undefinedTermIds for why a render-time throw doesn't).
 * A draft may keep the empty sections changelog:new scaffolds.
 */
export function sectionProblems(body: string, draft: boolean): string[] {
	const sections: { name: string; content: string }[] = [];
	let inFence = false;
	for (const line of body.split("\n")) {
		if (FENCE.test(line.trim())) inFence = !inFence;
		const heading = inFence ? null : HEADING.exec(line);
		if (heading) sections.push({ name: heading[1], content: "" });
		else if (sections.length > 0)
			sections[sections.length - 1].content += `${line}\n`;
	}

	const order = SECTIONS.join(", ");
	const known: readonly string[] = SECTIONS;
	const problems: string[] = [];
	const seen = new Set<string>();
	let last = -1;
	for (const { name, content } of sections) {
		const index = known.indexOf(name);
		if (index === -1) {
			problems.push(`unknown section "${name}"; use one of: ${order}`);
			continue;
		}
		if (seen.has(name)) {
			problems.push(`section "${name}" appears twice`);
			continue;
		}
		seen.add(name);
		if (index < last)
			problems.push(`section "${name}" is out of order; the order is ${order}`);
		last = Math.max(last, index);
		if (!draft && content.replace(MDX_COMMENT, "").trim() === "")
			problems.push(`section "${name}" is empty; leave it out`);
	}
	if (!draft && sections.length === 0)
		problems.push("a published entry needs at least one section");
	return problems;
}

/**
 * Everything that should stop the build for one entry, each prefixed with
 * its id. `knownPlugins` is the slugs that have a page under /plugins/.
 */
export function entryProblems(
	entry: EntryLike,
	knownPlugins: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	const end = isoDay(entry.data.weekEnd);
	if (entry.id !== end)
		problems.push(
			`the file is named ${entry.id} but weekEnd is ${end}; name it ${end}.mdx`,
		);
	for (const plugin of entry.data.plugins) {
		if (!knownPlugins.has(plugin.name))
			problems.push(`plugins: no plugin page for "${plugin.name}"`);
	}
	problems.push(...sectionProblems(entry.body ?? "", entry.data.draft));
	return problems.map((p) => `${entry.id}: ${p}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @onlooker/website test changelog-entries`
Expected: PASS, 29 tests.

Then run `pnpm --filter @onlooker/website lint`. It should report nothing in these two files; fix any formatting with Edit.

- [ ] **Step 5: Commit**

Commit `apps/website/src/lib/changelog-entries.ts`, `apps/website/src/__tests__/changelog-entries.test.ts` and this plan, `docs/superpowers/plans/2026-11-21-website-changelog.md`. Suggested subject: `feat(website): define what a changelog entry is`.

---

### Task 2: The collection, the pages and the first entry

**Files:**
- Modify: `apps/website/src/content.config.ts`
- Create: `apps/website/src/data/changelog.ts`
- Create: `apps/website/src/components/changelog/EntryList.astro`
- Create: `apps/website/src/components/changelog/PluginReleases.astro`
- Create: `apps/website/src/layouts/ChangelogEntry.astro`
- Create: `apps/website/src/pages/changelog/index.astro`
- Create: `apps/website/src/pages/changelog/[slug].astro`
- Create: `apps/website/src/pages/changelog/rss.xml.ts`
- Create: `apps/website/src/content/changelog/2026-11-20.mdx`
- Modify: `apps/website/src/lib/launch-gate.ts`
- Modify: `apps/website/src/__tests__/launch-gate.test.ts`
- Create: `apps/website/src/__tests__/changelog-routes.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1, everything in `../lib/changelog-entries`.
  - `dropsDrafts` from `src/lib/blog-posts.ts`, `allProse` from `src/data/plugins/index.ts` (each has a `slug`), `undefinedTermIds` from `src/lib/glossary.ts`, and `Layout.astro`, whose props are `title`, `description`, `ogType`, `publishedTime` and `canonicalPath`.
- Produces: `publishedEntries()` in `src/data/changelog.ts`, which returns the collection's entries with drafts filtered and the newest first. Task 3 uses it.

- [ ] **Step 1: Write the failing tests**

Create `apps/website/src/__tests__/changelog-routes.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import EntryList from "../components/changelog/EntryList.astro";
import PluginReleases from "../components/changelog/PluginReleases.astro";
import { entrySchema } from "../lib/changelog-entries";

const CHANGELOG = new URL("../pages/changelog/", import.meta.url);

// Static content, so every route prerenders, as the blog's do.
describe("changelog routes", () => {
	const files = readdirSync(CHANGELOG, { recursive: true, encoding: "utf8" })
		.filter((f) => /\.(astro|ts)$/.test(f))
		.sort();

	it("are the ones ONL-302 names", () => {
		expect(files).toEqual(["[slug].astro", "index.astro", "rss.xml.ts"]);
	});

	for (const file of files) {
		it(`${file} is prerendered`, () => {
			expect(readFileSync(new URL(file, CHANGELOG), "utf8")).toMatch(
				/export const prerender = true;/,
			);
		});
	}
});

async function render(
	component: Parameters<AstroContainer["renderToString"]>[0],
	props: Record<string, unknown>,
): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(component, { props });
}

describe("EntryList", () => {
	it("says so when nothing is published", async () => {
		expect(await render(EntryList, { entries: [] })).toContain(
			"Nothing published yet.",
		);
	});

	it("links each entry by its week, with the week and summary", async () => {
		const html = await render(EntryList, {
			entries: [
				{
					id: "2026-11-20",
					data: entrySchema.parse({
						title: "Lock fix",
						weekStart: "2026-11-14",
						weekEnd: "2026-11-20",
						summary: "What changed.",
					}),
				},
			],
		});
		expect(html).toMatch(
			/<a[^>]*href="\/changelog\/2026-11-20\/"[^>]*>Lock fix<\/a>/,
		);
		expect(html).toContain("November 14 to 20, 2026");
		expect(html).toContain('datetime="2026-11-20"');
		expect(html).toContain("What changed.");
	});
});

describe("PluginReleases", () => {
	it("links each release to its plugin page", async () => {
		const html = await render(PluginReleases, {
			plugins: [{ name: "lineage", version: "0.10.5" }],
		});
		expect(html).toMatch(
			/<a[^>]*href="\/plugins\/lineage\/"[^>]*>lineage 0\.10\.5<\/a>/,
		);
		expect(html).toContain('aria-label="Plugin releases this week"');
	});

	it("renders nothing for a week with no releases", async () => {
		const html = await render(PluginReleases, { plugins: [] });
		expect(html).not.toContain("<ul");
	});
});
```

In `apps/website/src/__tests__/launch-gate.test.ts`, use Edit to add these to the "lets through" list, after `"/glossary/",`:

```ts
		"/changelog",
		"/changelog/",
		"/changelog/2026-11-20/",
		"/changelog/rss.xml",
```

Add `"/changelogx",` to the "keeps behind the gate" list, after `"/pluginsx",`.

- [ ] **Step 2: Run the tests to verify they fail**

Run `pnpm --filter @onlooker/website test changelog-routes` and `pnpm --filter @onlooker/website test launch-gate`.
Expected: both FAIL. The components and the pages directory don't exist yet, and the gate doesn't let the changelog paths through.

- [ ] **Step 3: Write the implementation**

`apps/website/src/content.config.ts` becomes:

```ts
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
```

Create `apps/website/src/data/changelog.ts`:

```ts
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
```

Create `apps/website/src/components/changelog/EntryList.astro`:

```astro
---
import {
	type EntryLike,
	entryPath,
	formatWeek,
	isoDay,
} from "../../lib/changelog-entries";

interface Props {
	entries: EntryLike[];
}

const { entries } = Astro.props;
---

{
  entries.length === 0 ? (
    <p class="post-empty">Nothing published yet.</p>
  ) : (
    <ol class="post-list">
      {entries.map((entry) => (
        <li class="post-item">
          <time datetime={isoDay(entry.data.weekEnd)}>
            {formatWeek(entry.data.weekStart, entry.data.weekEnd)}
          </time>
          <h2 class="post-title">
            <a href={entryPath(entry.id)}>{entry.data.title}</a>
          </h2>
          <p class="post-description">{entry.data.summary}</p>
        </li>
      ))}
    </ol>
  )
}
```

Create `apps/website/src/components/changelog/PluginReleases.astro`:

```astro
---
import type { EntryData } from "../../lib/changelog-entries";

interface Props {
	plugins: EntryData["plugins"];
}

const { plugins } = Astro.props;
---

{/* Chips, not a heading: a heading would collide with the body's "## Plugins". */}
{
  plugins.length > 0 && (
    <ul class="post-tags" aria-label="Plugin releases this week">
      {plugins.map((plugin) => (
        <li>
          <a href={`/plugins/${plugin.name}/`}>{plugin.name} {plugin.version}</a>
        </li>
      ))}
    </ul>
  )
}
```

Create `apps/website/src/layouts/ChangelogEntry.astro`:

```astro
---
import PluginReleases from "../components/changelog/PluginReleases.astro";
import {
	type EntryLike,
	entryPath,
	formatWeek,
	isoDay,
} from "../lib/changelog-entries";
import Layout from "./Layout.astro";

interface Props {
	entry: EntryLike;
}

const { entry } = Astro.props;
const { title, summary, weekStart, weekEnd, plugins } = entry.data;
---

<Layout
  title={`${title} — Onlooker changelog`}
  description={summary}
  ogType="article"
  publishedTime={weekEnd}
  canonicalPath={entryPath(entry.id)}
>
  <main class="prose-page">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span class="sep">/</span>
      <a href="/changelog/">Changelog</a>
    </nav>
    <article class="prose">
      <header class="post-header">
        <h1>{title}</h1>
        <p class="post-meta">
          <time datetime={isoDay(weekEnd)}>{formatWeek(weekStart, weekEnd)}</time>
        </p>
        <PluginReleases plugins={plugins} />
      </header>
      <p>{summary}</p>
      <slot />
    </article>
  </main>
</Layout>
```

Create `apps/website/src/pages/changelog/index.astro`:

```astro
---
import EntryList from "../../components/changelog/EntryList.astro";
import { publishedEntries } from "../../data/changelog";
import Layout from "../../layouts/Layout.astro";

export const prerender = true;

const entries = await publishedEntries();
---

<Layout
  title="Changelog — Onlooker"
  description="What changed in Onlooker each week: plugin releases, site changes and reliability work."
>
  <main class="prose-page">
    <header class="page-header">
      <p class="eyebrow">Changelog</p>
      <h1>What changed each week</h1>
    </header>
    <EntryList entries={entries} />
  </main>
</Layout>
```

Create `apps/website/src/pages/changelog/[slug].astro`:

```astro
---
import { render } from "astro:content";
import { publishedEntries } from "../../data/changelog";
import { allProse } from "../../data/plugins";
import ChangelogEntry from "../../layouts/ChangelogEntry.astro";
import { entryProblems } from "../../lib/changelog-entries";
import { undefinedTermIds } from "../../lib/glossary";

export const prerender = true;

export async function getStaticPaths() {
	const entries = await publishedEntries();
	const plugins = new Set(allProse.map((p) => p.slug));
	// Here rather than mid-render, because a throw here stops the build and a
	// throw mid-render does not. See undefinedTermIds.
	const problems = entries.flatMap((entry) => [
		...entryProblems(entry, plugins),
		...undefinedTermIds(entry.body ?? "").map(
			(id) => `${entry.id}: <Term> id with no glossary entry: ${id}`,
		),
	]);
	if (problems.length > 0) {
		throw new Error(`Changelog entries to fix:\n${problems.join("\n")}`);
	}
	return entries.map((entry) => ({
		params: { slug: entry.id },
		props: { entry },
	}));
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---

<ChangelogEntry entry={entry}>
  <Content />
</ChangelogEntry>
```

Create `apps/website/src/pages/changelog/rss.xml.ts`:

```ts
import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { publishedEntries } from "../../data/changelog";
import { entryFeedItems } from "../../lib/changelog-entries";
import { SITE_URL } from "../../lib/site";

export const prerender = true;

export async function GET(context: APIContext) {
	return rss({
		title: "Onlooker changelog",
		description:
			"What changed in Onlooker each week: plugin releases, site changes and reliability work.",
		site: context.site ?? SITE_URL,
		items: entryFeedItems(await publishedEntries()),
	});
}
```

In `apps/website/src/lib/launch-gate.ts`, use Edit to add these lines after the `pathname.startsWith("/blog/") ||` line:

```ts
		pathname === "/changelog" ||
		pathname.startsWith("/changelog/") ||
```

Create `apps/website/src/content/changelog/2026-11-20.mdx`. The prose comes from the doc "Onlooker changelog, Nov 14 to 20, 2026", lightly linked:

```mdx
---
title: "Lock fix for eight plugins, a glossary, louder site builds"
weekStart: 2026-11-14
weekEnd: 2026-11-20
summary: "This week we fixed a lock bug shared by eight plugins, added a glossary to the site, and made site builds fail loudly instead of shipping a broken page."
plugins:
  - name: bursar
    version: "0.9.6"
  - name: cartographer
    version: "0.13.6"
  - name: counsel
    version: "0.13.5"
  - name: governor
    version: "0.8.5"
  - name: historian
    version: "0.13.6"
  - name: inspector
    version: "0.11.2"
  - name: lineage
    version: "0.10.5"
  - name: scribe
    version: "0.11.5"
draft: false
---

import Term from "../../components/Term.astro";

## Plugins

- **Two hooks can no longer hold the same lock.** Bursar, cartographer, counsel, governor, historian, inspector, lineage and scribe share one lock. When a hook released it at the same moment another hook decided it was stale, both could end up holding it, and for lineage that meant a change recorded twice in the ledger. A lock whose holder is still running is now never removed, and a new test drives that exact timing.

## onlooker.dev

- **New glossary.** Terms like <Term id="contrast-arena">contrast arena</Term> and <Term id="substrate">substrate</Term> now have one plain definition each in the [glossary](/glossary/), and posts link to them the first time they come up.
- **New post:** ["Your Claude config might not be in ~/.claude"](/blog/claude-config-dir/), on the plugins that assumed a default config path and what we changed.

## Reliability

- **Site builds fail on a half-rendered page.** If a page broke partway through rendering, the build used to pass and publish the cut-off page. Now the build stops and names the page.

## Behind the scenes

We hardened the test suites (CLI tests can no longer reach a live server, and a flaky lineage test now reports what it saw when it fails), fixed a few tests that only failed when run on their own, and tidied internal docs.

If you run any of the plugins above, update them to pick up the lock fix.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run `pnpm --filter @onlooker/website test changelog-routes` and `pnpm --filter @onlooker/website test launch-gate`.
Expected: both PASS.

Then run `pnpm --filter @onlooker/website test`, the full website suite. Expected: PASS. If the AstroContainer render of an `.astro` component that imports `astro:content` fails, tell the controller rather than restructuring. `EntryList` and `PluginReleases` are written to import only the pure lib for this reason.

Run `pnpm --filter @onlooker/website typecheck` and `pnpm --filter @onlooker/website lint`. Expected: both clean. `astro check` syncs the content collections, so a schema error in the entry shows up here.

- [ ] **Step 5: Build the site and look at the output**

From the repo root, run `env -u SITE_LAUNCHED pnpm --filter @onlooker/website build`. Expected:
- The build passes, and the complete-pages log line counts 2 more pages than a build of `main`.
- Each of these has `<h1>` text and is not a `Redirecting to: /` document: `apps/website/dist/client/changelog/index.html` (or wherever the build writes prerendered HTML; find it with `find apps/website/dist -path '*changelog*'`) and `.../changelog/2026-11-20/index.html`.
- `.../changelog/rss.xml` has one `<item>` linking `https://onlooker.dev/changelog/2026-11-20/`.

Record the paths and what you saw in your report.

- [ ] **Step 6: Commit**

Commit every file this task lists. Suggested subject: `feat(website): publish a weekly changelog at /changelog`.

---

### Task 3: Link the changelog from the nav, footer, feed list and home page

**Files:**
- Modify: `apps/website/src/layouts/Layout.astro`
- Modify: `apps/website/src/__tests__/layout-meta.test.ts`
- Rename: `apps/website/src/components/blog/LatestPost.astro` to `apps/website/src/components/LatestLink.astro`
- Rename: `apps/website/src/__tests__/latest-post.test.ts` to `apps/website/src/__tests__/latest-link.test.ts`
- Modify: `apps/website/src/pages/index.astro`

**Interfaces:**
- Consumes: `publishedEntries()` from `src/data/changelog.ts` (Task 2), and `entryPath` from `src/lib/changelog-entries.ts` (Task 1).
- Produces: `LatestLink.astro` with props `{ label: string; href?: string; title?: string }`. It renders nothing unless both `href` and `title` are given.

Use `git mv` for the two renames so history follows them. A rename isn't an edit, so the "no shell edits" rule doesn't forbid it. Then change the content with Edit.

- [ ] **Step 1: Write the failing tests**

In `apps/website/src/__tests__/layout-meta.test.ts`, add inside `describe("Layout meta", ...)`, after "advertises the feed":

```ts
	it("advertises the changelog feed too", async () => {
		expect(await render({})).toContain(
			'<link rel="alternate" type="application/rss+xml" title="Onlooker changelog" href="/changelog/rss.xml">',
		);
	});
```

Add inside `describe("Layout nav", ...)`:

```ts
	it("links the changelog from the nav", async () => {
		expect(await render({})).toMatch(
			/<a class="nav-link" href="\/changelog\/"[^>]*>Changelog<\/a>/,
		);
	});

	it("links the changelog from the footer", async () => {
		const html = await render({});
		const footer = html.slice(html.indexOf("<footer"));
		expect(footer).toMatch(/<a[^>]*href="\/changelog\/"[^>]*>Changelog<\/a>/);
	});
```

Move the test file with `git mv apps/website/src/__tests__/latest-post.test.ts apps/website/src/__tests__/latest-link.test.ts`, then replace its whole content using Write:

```ts
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import LatestLink from "../components/LatestLink.astro";

async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(LatestLink, { props });
}

// The landing page names the newest post and the newest changelog entry, so
// both are reachable from /. A build where everything is a draft must show no
// line at all, not "Latest post:" pointing nowhere.
describe("LatestLink", () => {
	it("links the title to its path, under its label", async () => {
		const html = await render({
			label: "Latest post",
			href: "/blog/contrast-arena/",
			title: "The arena",
		});
		expect(html).toContain("Latest post:");
		expect(html).toMatch(
			/<a[^>]*href="\/blog\/contrast-arena\/"[^>]*>The arena →<\/a>/,
		);
	});

	it("renders nothing when there is nothing to link", async () => {
		const html = await render({ label: "Latest update" });
		expect(html).not.toContain("Latest update");
		expect(html).not.toContain("<a");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `pnpm --filter @onlooker/website test layout-meta` and `pnpm --filter @onlooker/website test latest-link`.
Expected: the three new layout tests FAIL, and `latest-link` FAILS because `../components/LatestLink.astro` doesn't exist.

- [ ] **Step 3: Write the implementation**

In `apps/website/src/layouts/Layout.astro`, use Edit to make three changes:

1. After the blog feed's `<link rel="alternate" ...>` line, add:

```astro
    <link rel="alternate" type="application/rss+xml" title="Onlooker changelog" href="/changelog/rss.xml" />
```

2. After `<a class="nav-link" href="/blog/">Blog</a>`, add:

```astro
          <a class="nav-link" href="/changelog/">Changelog</a>
```

3. Inside `<div class="footer-links">`, before the GitHub link, add:

```astro
          <a href="/changelog/">Changelog</a>
```

Move the component with `git mv apps/website/src/components/blog/LatestPost.astro apps/website/src/components/LatestLink.astro`, then replace its frontmatter and markup using Edit or Write. Keep the existing `<style>` block, changing only the class name and adding the sibling rule:

```astro
---
interface Props {
	label: string;
	href?: string;
	title?: string;
}

const { label, href, title } = Astro.props;
---

{
  href && title && (
    <p class="latest-link">
      {label}: <a href={href}>{title} →</a>
    </p>
  )
}

<style>
  .latest-link {
    margin-top: 28px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
    letter-spacing: 0.04em;
    max-width: 560px;
    animation: fade-up 0.6s ease both 1.1s;
  }

  /* Two lines in a row read as one group, not two paragraphs. */
  .latest-link + .latest-link {
    margin-top: 8px;
  }

  .latest-link a {
    color: var(--text-1);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .latest-link a:hover,
  .latest-link a:focus-visible {
    color: var(--accent);
  }
</style>
```

In `apps/website/src/pages/index.astro`, replace the `LatestPost` import with:

```ts
import LatestLink from "../components/LatestLink.astro";
import { publishedEntries } from "../data/changelog";
import { entryPath } from "../lib/changelog-entries";
import { postPath } from "../lib/blog-posts";
```

Below `const posts = await publishedPosts();`, add `const entries = await publishedEntries();`. Then replace `<LatestPost post={posts[0]} />` with:

```astro
    <LatestLink
      label="Latest post"
      href={posts[0] && postPath(posts[0].id)}
      title={posts[0]?.data.title}
    />
    <LatestLink
      label="Latest update"
      href={entries[0] && entryPath(entries[0].id)}
      title={entries[0]?.data.title}
    />
```

Run `grep -rn "LatestPost" apps/website/src`. Expected: no output.

- [ ] **Step 4: Run the tests to verify they pass**

Run `pnpm --filter @onlooker/website test layout-meta` and `pnpm --filter @onlooker/website test latest-link`. Expected: PASS.

Then run the full website suite, typecheck and lint. Expected: all clean. biome may want the imports sorted, so fix that with Edit.

- [ ] **Step 5: Commit**

Commit the five paths above (`git add` takes the renames). Suggested subject: `feat(website): link the changelog from every page`.

---

### Task 4: `pnpm changelog:new`

**Files:**
- Create: `apps/website/src/lib/changelog-scaffold.ts`
- Create: `apps/website/src/__tests__/changelog-scaffold.test.ts`
- Create: `apps/website/scripts/changelog-new.ts`
- Modify: the root `package.json`, adding a script beside `"seed:dev"`

**Interfaces:**
- Consumes: from Task 1, `SECTIONS`, `formatWeek`, `isoDay` and `sectionProblems`.
- Produces:
  - `weekOf(today: string): { weekStart: string; weekEnd: string }`, with input and output as `"YYYY-MM-DD"`.
  - `scaffold(week: { weekStart: string; weekEnd: string }): string`

- [ ] **Step 1: Write the failing test**

Create `apps/website/src/__tests__/changelog-scaffold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sectionProblems } from "../lib/changelog-entries";
import { scaffold, weekOf } from "../lib/changelog-scaffold";

describe("weekOf", () => {
	// Weeks run Saturday to Friday, named for the Friday.
	it("starts a week on a Saturday", () => {
		expect(weekOf("2026-11-21")).toEqual({
			weekStart: "2026-11-21",
			weekEnd: "2026-11-27",
		});
	});

	it("puts a Friday at the end of its own week", () => {
		expect(weekOf("2026-11-20")).toEqual({
			weekStart: "2026-11-14",
			weekEnd: "2026-11-20",
		});
	});

	it("crosses a month", () => {
		expect(weekOf("2026-12-02")).toEqual({
			weekStart: "2026-11-28",
			weekEnd: "2026-12-04",
		});
	});

	it("refuses a date it can't read", () => {
		expect(() => weekOf("2026-13-01")).toThrow(/YYYY-MM-DD/);
		expect(() => weekOf("Nov 21")).toThrow(/YYYY-MM-DD/);
	});
});

describe("scaffold", () => {
	const week = { weekStart: "2026-11-21", weekEnd: "2026-11-27" };
	const file = scaffold(week);
	const body = file.split("\n---\n")[1];

	it("fills the frontmatter as a draft", () => {
		expect(file.startsWith("---\n")).toBe(true);
		expect(file).toContain('title: "Draft: November 21 to 27, 2026"');
		expect(file).toContain("weekStart: 2026-11-21\n");
		expect(file).toContain("weekEnd: 2026-11-27\n");
		expect(file).toContain("draft: true\n");
	});

	it("lays out every section but Hosted feed, in order", () => {
		const headings = body.split("\n").filter((l) => l.startsWith("## "));
		expect(headings).toEqual([
			"## Plugins",
			"## onlooker.dev",
			"## Reliability",
			"## Behind the scenes",
		]);
	});

	// A draft builds with its empty sections; publishing one fails until each
	// is written or deleted.
	it("passes as a draft and fails as a published entry", () => {
		expect(sectionProblems(body, true)).toEqual([]);
		expect(sectionProblems(body, false)).toHaveLength(4);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/website test changelog-scaffold`
Expected: FAIL, because `../lib/changelog-scaffold` can't be resolved.

- [ ] **Step 3: Write the implementation**

Create `apps/website/src/lib/changelog-scaffold.ts`:

```ts
import { formatWeek, isoDay, SECTIONS } from "./changelog-entries";

const DAY_MS = 86_400_000;
const FRIDAY = 5;

/**
 * The Saturday-to-Friday week that holds `today` ("YYYY-MM-DD"). Dates in and
 * out are calendar days, never instants, so the runner's timezone can't move
 * a week.
 */
export function weekOf(today: string): { weekStart: string; weekEnd: string } {
	const day = new Date(`${today}T00:00:00Z`);
	if (Number.isNaN(day.valueOf()) || isoDay(day) !== today) {
		throw new Error(`Expected a YYYY-MM-DD date, got "${today}"`);
	}
	const toFriday = (FRIDAY - day.getUTCDay() + 7) % 7;
	const end = new Date(day.valueOf() + toFriday * DAY_MS);
	return {
		weekStart: isoDay(new Date(end.valueOf() - 6 * DAY_MS)),
		weekEnd: isoDay(end),
	};
}

// Hosted feed is left out until the hosted feed opens (plan doc, Nov 20).
const SCAFFOLDED = SECTIONS.filter((s) => s !== "Hosted feed");

const PROMPT =
	"{/* One bullet per change: a bold lead line saying what changed for the reader, then a sentence or two on why it matters. Delete the section if it stays empty. */}";

/** A draft entry for the week, with every heading in place. */
export function scaffold(week: { weekStart: string; weekEnd: string }): string {
	const range = formatWeek(new Date(week.weekStart), new Date(week.weekEnd));
	const sections = SCAFFOLDED.map((s) => `## ${s}\n\n${PROMPT}\n`).join("\n");
	return `---
title: "Draft: ${range}"
weekStart: ${week.weekStart}
weekEnd: ${week.weekEnd}
summary: "Draft. One or two sentences on what changed for readers this week."
# plugins:  # versions from each plugin's own CHANGELOG.md, not the root one
#   - name: lineage
#     version: "0.10.5"
draft: true
---

${sections}
{/* End with what to do, if anything, such as "update these plugins to pick up the fix". */}
`;
}
```

Create `apps/website/scripts/changelog-new.ts`:

```ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scaffold, weekOf } from "../src/lib/changelog-scaffold";

// pnpm changelog:new [YYYY-MM-DD]: writes this week's draft entry, or the
// week holding the date given. Never overwrites an entry that exists.

function localToday(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const week = weekOf(process.argv[2] ?? localToday());
const file = fileURLToPath(
	new URL(`../src/content/changelog/${week.weekEnd}.mdx`, import.meta.url),
);

try {
	writeFileSync(file, scaffold(week), { flag: "wx" });
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		console.error(`${file} already exists. Edit it instead.`);
		process.exit(1);
	}
	throw error;
}

console.log(`Wrote ${file} as a draft.`);
console.log(
	"Fill each section or delete it, set the title and summary, then flip draft to false to publish.",
);
```

In the root `package.json`, use Edit to add this after the `"seed:dev"` line:

```json
		"changelog:new": "tsx apps/website/scripts/changelog-new.ts",
```

- [ ] **Step 4: Run the tests and try the script**

Run: `pnpm --filter @onlooker/website test changelog-scaffold`
Expected: PASS, 7 tests.

From the repo root, run `pnpm changelog:new 2026-11-21`. It should write `apps/website/src/content/changelog/2026-11-27.mdx`. Check two things:
- Run `pnpm changelog:new 2026-11-21` again. Expected: exit 1 with "already exists".
- Run `pnpm --filter @onlooker/website typecheck`. Expected: clean, because the draft parses.

Then delete the scaffolded file with `rm apps/website/src/content/changelog/2026-11-27.mdx`, since it's untracked and not part of this PR.

Run the full website suite and lint. Expected: clean.

- [ ] **Step 5: Commit**

Commit `apps/website/src/lib/changelog-scaffold.ts`, `apps/website/src/__tests__/changelog-scaffold.test.ts`, `apps/website/scripts/changelog-new.ts` and `package.json`. Suggested subject: `feat(website): scaffold next week's changelog entry`.

---

### Task 5: Prove the build, then open the PR

This task changes no code. It produces the evidence for the PR.

- [ ] **Step 1: Check that a draft stays out of production.** Run `pnpm changelog:new 2026-11-21` to write a draft. Then run `env -u SITE_LAUNCHED pnpm --filter @onlooker/website build` and confirm:
  - No `changelog/2026-11-27` directory exists in the build output.
  - The RSS feed has one `<item>`.
  - The index lists one entry.

  Delete the draft afterwards.
- [ ] **Step 2: Check the gate.** In that same build output, `/changelog/` and `/changelog/2026-11-20/` are real pages with an `<h1>`, not `Redirecting to: /`. The complete-pages hook logged its count with no error.
- [ ] **Step 3: Check contrast.** Confirm that no new color or color token appears in the diff: `git diff main -- apps/website | grep -nE '#[0-9a-fA-F]{3,8}\b|rgb|oklch|--[a-z-]+:'` should print nothing. Then the token contrast tests (`derived-surfaces`, `packages/brand/tokens.test.ts`) cover the new pages unchanged.
- [ ] **Step 4: Look at it in a browser.** With `pnpm --filter @onlooker/website dev`, check:
  - `/changelog/`, `/changelog/2026-11-20/` and `/` in light and dark.
  - The narrowest window width, for horizontal scroll.
  - The nav, footer and "Latest update" links.

  Take screenshots.
- [ ] **Step 5: Open the PR** through `/git-workflow:pr`, with `Closes ONL-302`. The production check after deploy still has to happen, and is described in the body.
