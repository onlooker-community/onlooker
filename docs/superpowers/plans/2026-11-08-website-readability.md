# Website Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make onlooker.dev readable: a faint grid that scrolls away, the
pixel face only at sizes it renders at, and breadcrumbs and tags aligned with
their column.

**Architecture:** All CSS. The global stylesheet
`apps/website/src/styles/globals.css` and the scoped `<style>` blocks in
three `.astro` pages change. The grid gets a derived color token checked by
the existing contrast test. A new test parses every website stylesheet for
the pixel face's sizes.

**Tech Stack:** Astro 6, plain CSS, Vitest (with `getViteConfig`), Biome.

Spec: `docs/superpowers/specs/2026-11-08-website-readability-design.md`.

## Global Constraints

* Abaddon (`var(--display)` / `var(--font-display)`) is used only at a px
  size that is a multiple of 16. No `clamp()` or `vw` sizes with it.
* Every rule that uses Abaddon sets `letter-spacing: 0` and
  `font-weight: 700`. An em letter-spacing (today `-0.03em`, −1.44px at
  48px) moves each glyph off the pixel grid even at a legal size, and the
  face ships only 400 and 700.
* Page titles: `32px`, and `48px` at `@media (min-width: 768px)`. Landing
  `.headline`: `48px`, and `80px` at `@media (min-width: 768px)`.
* Blog list titles and article h2/h3 use `var(--sans)`, weight 700:
  `.post-title` `var(--text-body-lg)`, `.prose h2` `1.5rem`, `.prose h3`
  `1.2rem`.
* Grid line: `--grid-line: color-mix(in srgb, var(--edge) 18%, var(--ground))`.
  Measured 2026-11-08: 1.221:1 by day, 1.189:1 at night. It must stay between
  1.1 and 1.3 against `--ground` in both themes.
* Out of scope: the radar circles, `body::after` (the teal glow), and the
  landing fade-in (ONL-270).
* Edit tracked files with the Edit/Write tools, never the shell.
* Run one test file with the name straight after `test` and no `--`:
  `pnpm --filter @onlooker/website test derived-surfaces`.
* Commits go through `/git-workflow:commit`, in American English.

---

### Task 1: A faint grid that scrolls away

**Files:**
- Modify: `apps/website/src/styles/globals.css` (the `:root` alias block at
  lines 15–52, and `body::before` at lines 101–116)
- Test: `apps/website/src/__tests__/derived-surfaces.test.ts`

**Interfaces:**
- Produces: the CSS custom property `--grid-line`, defined in `globals.css`.

- [ ] **Step 1: Generalize the recipe reader and write the failing tests**

In `derived-surfaces.test.ts`, replace `bg3Recipe` (it reads only `--bg-3`)
with a reader for any derived token, and update its two callers in the
`--bg-3` describe block from `bg3Recipe()` to `recipe("--bg-3")`:

```ts
/** Pull a derived token's recipe out of globals.css rather than restating it here. */
function recipe(name: string): {
	source: string;
	percent: number;
	toward: string;
} {
	const m = new RegExp(
		`${name}:\\s*color-mix\\(in srgb,\\s*var\\((--[a-z-]+)\\)\\s*(\\d+)%,\\s*var\\((--[a-z-]+)\\)\\)`,
	).exec(site);
	if (!m) throw new Error(`${name} is no longer a two-token srgb color-mix`);
	return { source: m[1], percent: Number(m[2]) / 100, toward: m[3] };
}
```

Then add, after the `--bg-3` describe block:

```ts
// The grid sits behind every page, body text included. Drawn in --edge it
// measured 3.71 by day and 3.04 at night against --ground: the strength of a
// border, not of a texture. These bounds keep it visible and keep it from
// competing with the text it sits behind.
describe("--grid-line, the background grid", () => {
	const THEMES: Array<[string, string]> = [
		["night", ":root"],
		["day", ':root[data-theme="light"]'],
	];

	for (const [name, selector] of THEMES) {
		it(`${name}: it is faint against --ground, but there`, () => {
			const t = tokens(brand, selector);
			const { source, percent, toward } = recipe("--grid-line");
			const line = colorMix(t[source], percent, t[toward]);
			const ratio = contrast(line, t["--ground"]);

			expect(ratio, `--grid-line (${line}) in ${name}`).toBeGreaterThanOrEqual(1.1);
			expect(ratio, `--grid-line (${line}) in ${name}`).toBeLessThanOrEqual(1.3);
		});
	}

	// Fixed, the grid stayed under the text however far it scrolled, and its
	// fade was measured from the viewport rather than the page.
	it("is drawn in --grid-line and scrolls with the page", () => {
		const block = /body::before\s*\{([^}]*)\}/.exec(site)?.[1] ?? "";
		expect(block).toMatch(/position:\s*absolute/);
		expect(block).toMatch(/var\(--grid-line\)/);
		expect(block).not.toMatch(/var\(--border\)/);
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @onlooker/website test derived-surfaces`
Expected: the `--bg-3` and code-block tests pass. The three `--grid-line`
tests fail: the two contrast tests with "--grid-line is no longer a
two-token srgb color-mix", the last on `position: absolute`.

- [ ] **Step 3: Define the token**

In `globals.css`, inside the `:root` alias block, directly after the
`--border-2` line, add:

```css
	/* The background grid. In --edge it measured 3.71 by day and 3.04 at night
	 * against --ground, the strength of a border, and it sat behind the body
	 * text on every page. 18% edge reads 1.22 by day and 1.19 at night: still
	 * a texture, no longer a competitor. derived-surfaces.test.ts holds it
	 * between 1.1 and 1.3 in both themes. */
	--grid-line: color-mix(in srgb, var(--edge) 18%, var(--ground));
```

- [ ] **Step 4: Redraw the grid**

Replace the whole `body::before` rule with:

```css
/* Absolute, not fixed, so the grid belongs to the top of the page and scrolls
 * away with it. Fixed, its fade was measured from the viewport, and the text
 * of a long post always scrolled over the strongest part. */
body::before {
	content: "";
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	height: 100vh;
	background-image:
		linear-gradient(var(--grid-line) 1px, transparent 1px),
		linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
	background-size: 60px 60px;
	mask-image: linear-gradient(to bottom, black 30%, transparent 100%);
	pointer-events: none;
	z-index: 0;
}
```

`body` is already `position: relative`, so `top: 0` is the top of the page.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test derived-surfaces`
Expected: all pass.

- [ ] **Step 6: Prove the contrast test by ablation**

Change `18%` to `40%` in `--grid-line`, rerun, and confirm the day test
fails above 1.3. Change it to `5%`, confirm a test fails below 1.1. Restore
`18%` and confirm green.

- [ ] **Step 7: Lint and commit**

Run: `pnpm --filter @onlooker/website lint`. Expected: clean.
Commit with `/git-workflow:commit`, files `apps/website/src/styles/globals.css`
and `apps/website/src/__tests__/derived-surfaces.test.ts`.

---

### Task 2: Breadcrumbs and tags stop inheriting other elements' styles

**Files:**
- Modify: `apps/website/src/layouts/Layout.astro:44` (the header `<nav>`)
- Modify: `apps/website/src/styles/globals.css` (the `nav {` rule at line
  143, the `nav {` selectors in the media blocks at lines 225–233 and
  355–358, and `.prose ul, .prose ol` at lines 530–533)
- Test: `apps/website/src/__tests__/layout-meta.test.ts`

**Interfaces:**
- Produces: the class `site-nav` on the header `<nav>` in `Layout.astro`.
- Line numbers in `globals.css` are from before Task 1, which adds about ten
  lines above them. Find each rule by its selector.

- [ ] **Step 1: Write the failing tests**

Add to `layout-meta.test.ts`. Extend the imports at the top:

```ts
import { readFileSync } from "node:fs";
import BlogPost from "../layouts/BlogPost.astro";
import { postSchema } from "../lib/blog-posts";
```

Then add at the end of the file:

```ts
const globals = readFileSync(
	new URL("../styles/globals.css", import.meta.url),
	"utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

// Breadcrumbs are <nav> elements too. While the header was styled through a
// bare `nav` selector, every breadcrumb picked up its space-between, its 48px
// of padding and its bottom border.
describe("site header and breadcrumbs", () => {
	it("styles the header through a class, never a bare nav selector", () => {
		expect(globals).not.toMatch(/(^|[{},])\s*nav\s*[{,]/m);
	});

	it("marks the header nav as the site nav", async () => {
		expect(await render({})).toMatch(/<nav[^>]*class="site-nav"/);
	});

	it("leaves a post's breadcrumb unmarked", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(BlogPost, {
			props: {
				post: {
					id: "a-post",
					data: postSchema.parse({
						title: "A post",
						description: "About it.",
						published: "2026-11-01",
						tags: ["measurements"],
					}),
				},
			},
		});
		const breadcrumb = /<nav[^>]*aria-label="Breadcrumb"[^>]*>/.exec(html)?.[0];
		expect(breadcrumb).toBeDefined();
		expect(breadcrumb).not.toContain("site-nav");
	});
});

// The tag list under a post's title sits inside .prose, and the indent meant
// for markdown lists reached it. Markdown lists carry no class.
describe("prose lists", () => {
	it("indents only unclassed lists", () => {
		expect(globals).toMatch(
			/\.prose :is\(ul, ol\):not\(\[class\]\)\s*\{[^}]*padding-left/,
		);
		expect(globals).not.toMatch(/\.prose ul,\s*\.prose ol\s*\{/);
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @onlooker/website test layout-meta`
Expected: "styles the header through a class", "marks the header nav" and
"indents only unclassed lists" fail. "leaves a post's breadcrumb unmarked"
passes already. It guards against the class being added to the wrong `<nav>`.

- [ ] **Step 3: Mark the header**

In `Layout.astro`, change `<nav>` (line 44) to `<nav class="site-nav">`.

- [ ] **Step 4: Retarget the header rules**

In `globals.css`, change the selector `nav {` to `.site-nav {` in three
places: the rule at line 143, inside `@media (max-width: 640px)` at line 226,
and inside the second `@media (max-width: 640px)` at line 356. Leave the
declarations as they are.

- [ ] **Step 5: Exempt classed lists from the prose indent**

Replace:

```css
.prose ul,
.prose ol {
	padding-left: 1.4em;
}
```

with:

```css
/* Markdown lists carry no class. The tag list under a post's title does, and
 * sits inside .prose, so this indent used to reach it too. */
.prose :is(ul, ol):not([class]) {
	padding-left: 1.4em;
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test layout-meta`
Expected: all pass.

- [ ] **Step 7: Prove the tests by ablation**

Put back `nav {` at line 143 and confirm the selector test fails, then
restore. Put back `.prose ul, .prose ol` and confirm the list test fails,
then restore. Remove `class="site-nav"` from `Layout.astro` and confirm
"marks the header nav" fails, then restore.

- [ ] **Step 8: Lint, typecheck and commit**

Run: `pnpm --filter @onlooker/website lint` and
`pnpm --filter @onlooker/website typecheck`. Expected: clean, 0 errors.
Commit with `/git-workflow:commit`, files `apps/website/src/layouts/Layout.astro`,
`apps/website/src/styles/globals.css` and
`apps/website/src/__tests__/layout-meta.test.ts`.

---

### Task 3: The pixel face only at sizes it renders at

**Files:**
- Create: `apps/website/src/__tests__/display-sizes.test.ts`
- Modify: `apps/website/src/styles/globals.css` (`.post-title` at 439–444,
  `.post-header h1` at 490–496, `.prose h2, .prose h3` at 509–515)
- Modify: `apps/website/src/pages/index.astro` (`.headline` at 180–191)
- Modify: `apps/website/src/pages/plugins/index.astro` (`h1` at 162–170)
- Modify: `apps/website/src/pages/plugins/[slug].astro` (`h1` at 158–166)

**Interfaces:**
- Consumes: nothing from Tasks 1–2. Line numbers in `globals.css` may have
  moved by the lines Tasks 1–2 added; find rules by selector.

- [ ] **Step 1: Write the failing test**

Create `apps/website/src/__tests__/display-sizes.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Abaddon is a pixel face with a 16px design size. packages/brand says it
// renders cleanly only at integer multiples of that, and anything between
// "turns the art to mush". On 2026-11-08 every rule on the site that used it
// broke that: clamp() ranges on every page title, 22px list titles, and
// article headings at sizes inherited from the body text. An em
// letter-spacing does the same damage at a legal size, by moving every glyph
// off the pixel grid.
//
// This reads every stylesheet the site has, the global one and each .astro
// file's <style> blocks, so a new heading cannot opt out by living in a page.

const SRC = fileURLToPath(new URL("../", import.meta.url));
const DISPLAY = /font-family:\s*var\(--(?:font-)?display\)/;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : sources(path);
		}
		return /\.(css|astro)$/.test(entry.name) ? [path] : [];
	});
}

function stylesheet(path: string): string {
	const text = readFileSync(path, "utf8");
	const css = path.endsWith(".astro")
		? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
				.map((m) => m[1])
				.join("\n")
		: text;
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

type Rule = { selector: string; body: string; media: string | null };

/** Top-level rules, and the rules inside @media blocks. Other at-rules are skipped. */
function rules(css: string, media: string | null = null): Rule[] {
	const out: Rule[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		if (open < 0) break;
		let depth = 0;
		let close = open;
		for (; close < css.length; close++) {
			if (css[close] === "{") depth++;
			if (css[close] === "}" && --depth === 0) break;
		}
		const prelude = css.slice(i, open).trim().replace(/\s+/g, " ");
		const body = css.slice(open + 1, close);
		if (prelude.startsWith("@media")) out.push(...rules(body, prelude));
		else if (!prelude.startsWith("@")) out.push({ selector: prelude, body, media });
		i = close + 1;
	}
	return out;
}

function declared(body: string, property: string): string | undefined {
	return new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`).exec(body)?.[1].trim();
}

const files = sources(SRC).map((path) => ({
	name: relative(SRC, path),
	rules: rules(stylesheet(path)),
}));

const display = files.flatMap(({ name, rules }) =>
	rules
		.filter((r) => DISPLAY.test(r.body))
		.map((r) => ({ name, rule: r, all: rules })),
);

describe("the pixel face (Abaddon)", () => {
	// Four rules use it once this lands: the landing headline, the two plugin
	// page titles, and the blog's shared page-title rule. Fewer found means the
	// parser stopped seeing them, not that they were fixed.
	it("is found where the site uses it", () => {
		expect(display.length).toBeGreaterThanOrEqual(4);
	});

	for (const { name, rule, all } of display) {
		const label = `${name}: ${rule.selector}`;

		it(`${label} sets its own size, a multiple of 16px, at every breakpoint`, () => {
			expect(declared(rule.body, "font-size"), `${label} inherits its size`).toBeDefined();

			const sizes = all
				.filter((r) => r.selector === rule.selector)
				.map((r) => declared(r.body, "font-size"))
				.filter((size): size is string => size !== undefined);

			for (const size of sizes) {
				const px = /^(\d+)px$/.exec(size);
				expect(px, `${label} has font-size ${size}`).not.toBeNull();
				expect(Number(px?.[1]) % 16, `${label} has font-size ${size}`).toBe(0);
			}
		});

		it(`${label} keeps glyphs on the pixel grid`, () => {
			expect(declared(rule.body, "letter-spacing") ?? "0").toBe("0");
		});
	}
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/website test display-sizes`
Expected: "is found where the site uses it" passes. The size test fails for
`styles/globals.css: .post-title` (22px), `.post-header h1`
(`clamp(28px, 5vw, 40px)`), `.prose h2, .prose h3` (inherits its size),
`pages/index.astro: .headline`, `pages/plugins/index.astro: h1` and
`pages/plugins/[slug].astro: h1`. The letter-spacing test fails for the last
three, which set `-0.03em`.

- [ ] **Step 3: Move list titles and article headings to the body face**

In `globals.css`, replace the `.post-title` rule with:

```css
/* The body face, not the pixel face: a list title is a sentence, and pixel
 * type is slow to read at sentence length. */
.post-title {
	font-family: var(--sans);
	font-size: var(--text-body-lg);
	font-weight: 700;
	line-height: 1.3;
	margin: 6px 0 8px;
}
```

Replace the `.prose h2, .prose h3` rule with:

```css
.prose h2,
.prose h3 {
	font-family: var(--sans);
	font-weight: 700;
	color: var(--text-1);
	line-height: 1.25;
	margin-top: 2em;
}

.prose h2 {
	font-size: 1.5rem;
}

.prose h3 {
	font-size: 1.2rem;
}
```

- [ ] **Step 4: Snap the blog's page titles**

Replace the `.post-header h1` rule with one that also covers the blog index
and tag page titles (`.page-header h1`, in `pages/blog/index.astro` and
`pages/blog/tags/[tag].astro`):

```css
/* Page titles stay in the pixel face, at the two sizes it renders at. A
 * breakpoint steps between them; clamp() would land between multiples of 16. */
.post-header h1,
.page-header h1 {
	font-family: var(--display);
	font-size: 32px;
	font-weight: 700;
	letter-spacing: 0;
	line-height: 1.25;
	color: var(--text-1);
	margin-bottom: 12px;
}

@media (min-width: 768px) {
	.post-header h1,
	.page-header h1 {
		font-size: 48px;
	}
}
```

The plugins index also has a `.page-header` with an `h1`, so both this rule
and its scoped `h1` rule (Step 6) match it. They agree on size, weight and
letter-spacing but not on `line-height` (1 there) or `margin-bottom` (20px).
Astro emits scoped styles after imported stylesheets, so at equal specificity
the scoped values win and the page keeps the spacing it had.

- [ ] **Step 5: Snap the landing headline**

In `pages/index.astro`, in the `.headline` rule, change
`font-size: clamp(42px, 7vw, 84px);` to `font-size: 48px;`,
`font-weight: 800;` to `font-weight: 700;`, and
`letter-spacing: -0.03em;` to `letter-spacing: 0;`. Leave the other
declarations. Directly after the rule add:

```css
  /* 48px and 80px are 3x and 5x the face's 16px design size. clamp() put the
   * headline between multiples at nearly every width. */
  @media (min-width: 768px) {
    .headline {
      font-size: 80px;
    }
  }
```

- [ ] **Step 6: Snap the plugin page titles**

In `pages/plugins/index.astro`, in the scoped `h1` rule, change
`font-size: clamp(32px, 5vw, 56px);` to `font-size: 32px;`,
`font-weight: 800;` to `font-weight: 700;`, and
`letter-spacing: -0.03em;` to `letter-spacing: 0;`. Directly after the rule
add:

```css
  @media (min-width: 768px) {
    h1 {
      font-size: 48px;
    }
  }
```

In `pages/plugins/[slug].astro`, make the same three changes to its scoped
`h1` rule (its size is `clamp(28px, 5vw, 48px)`) and add the same media
block after it.

- [ ] **Step 7: Run the test and watch it pass**

Run: `pnpm --filter @onlooker/website test display-sizes`
Expected: all pass.

- [ ] **Step 8: Prove the test by ablation**

Each one fails, then restore it:
- `.headline`'s media size set to `84px`, so only the breakpoint is off-grid.
- `.post-title` given `font-family: var(--display)` and no size change, so it
  is 1.25rem.
- `letter-spacing: -0.03em` put back on the plugin page `h1`.

- [ ] **Step 9: Run the website suite, lint and typecheck**

Run: `pnpm --filter @onlooker/website test`,
`pnpm --filter @onlooker/website lint`,
`pnpm --filter @onlooker/website typecheck`.
Expected: every test passes, lint clean, 0 errors. `landing-copy.test.ts`
reads the landing page; if it asserts on the headline's styles, update only
what this task changed and say so in the report.

- [ ] **Step 10: Commit**

Commit with `/git-workflow:commit`, files
`apps/website/src/__tests__/display-sizes.test.ts`,
`apps/website/src/styles/globals.css`, `apps/website/src/pages/index.astro`,
`apps/website/src/pages/plugins/index.astro` and
`apps/website/src/pages/plugins/[slug].astro`.

---

### Task 4: Look at it (controller, not a subagent)

- [ ] Run `pnpm --filter @onlooker/website dev` and screenshot `/`, `/blog/`,
  `/blog/contrast-arena/` and `/plugins/archivist/` at 1440px and 375px, in
  both themes.
- [ ] Check: grid faint and gone below the first screen; page titles crisp;
  list titles and h2/h3 in the sans; breadcrumb "Home / Blog" tight, no
  rule beneath it; tags flush with the title; top-right nav not clipped.
- [ ] Run the full `pnpm test` from the repo root. Expected: every task
  successful.
