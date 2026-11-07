# Landing Page Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every claim on onlooker.dev's `/` name something that ships, and link the page to the blog's latest post (ONL-267).

**Architecture:** A new `LatestPost.astro` component renders a link to the newest published post, or nothing. `index.astro` keeps its layout, form and telemetry script; only its copy and pills change, and it feeds `LatestPost` from `publishedPosts()`, the collection's only reader.

**Tech Stack:** Astro 6 (prerendered page), vitest through `getViteConfig` with `configFile: false`, `experimental_AstroContainer`.

Spec: `docs/superpowers/specs/2026-11-07-landing-page-claims-design.md`.

## Global Constraints

- Every path below is relative to `apps/website/` unless it starts with `docs/`.
- Run tests with `pnpm --filter @onlooker/website test <name>` — the name goes straight after `test`, with **no `--`** (`test -- x` runs the whole suite).
- Edit tracked files with the Edit/Write tools, never `sed -i` or heredocs (the repo's lineage plugin only sees tool edits).
- Commit through the `/git-workflow:commit` skill. If you are a subagent without it, do not commit: stop and report, and the controller commits.
- American English in code, comments and copy.
- Exact copy, verbatim:
  - Eyebrow: `Hosted version coming soon`
  - Subhead: `Onlooker is a set of open-source Claude Code plugins that watch what your agents do: which change wrote which line, which claims the commands actually back up, what a session decided before its context ran out. Nothing goes to an Onlooker server: what they record stays on your machine.`
  - Layout description (meta and og): `Open-source Claude Code plugins that record what your agents do, and keep the record on your machine.`
  - Form note: `No spam. Hosted early access + launch updates only.`
  - Pills, in order: `Claude Code plugins`; `MIT licensed` → `https://github.com/onlooker-community/ecosystem/blob/main/LICENSE`; `Local-first`; `Source on GitHub` → `https://github.com/onlooker-community/ecosystem`
  - Latest post line: `Latest post: ` then a link whose text is the title followed by ` →`
- Linked pills open in the same tab (no `target`). Their hover changes `border-color` to `var(--accent)` only — no new background, so no new derived surface.
- Unchanged: the headline, the form markup and ids, `https://formsubmit.co/ajax/early@onlooker.dev`, the `<script>` block, the 640px media rule, `src/lib/launch-gate.ts`.
- Biome formats with tabs in `.ts` files; match the neighboring tests.

---

### Task 1: LatestPost component

**Files:**
- Create: `src/components/blog/LatestPost.astro`
- Test: `src/__tests__/latest-post.test.ts`

**Interfaces:**
- Consumes: `PostLike` (`{ id: string; data: PostData }`) and `postPath(id: string): string` (returns `/blog/<id>/`) from `src/lib/blog-posts.ts`; `postSchema` from the same file to build test data.
- Produces: `LatestPost.astro` with props `{ post?: PostLike }`. Renders `<p class="latest-post">Latest post: <a href="/blog/<id>/">Title →</a></p>`, or nothing when `post` is undefined.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/latest-post.test.ts`:

```ts
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import LatestPost from "../components/blog/LatestPost.astro";
import { postSchema } from "../lib/blog-posts";

async function render(props: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(LatestPost, { props });
}

// The landing page shows the newest post so the blog is reachable from /.
// A build with nothing published (every post a draft) must show no line at
// all, not "Latest post:" pointing nowhere.
describe("LatestPost", () => {
	it("links the newest post's title to its path", async () => {
		const html = await render({
			post: {
				id: "contrast-arena",
				data: postSchema.parse({
					title: "The arena",
					description: "What it showed.",
					published: "2026-11-01",
					tags: ["measurements"],
				}),
			},
		});
		expect(html).toContain("Latest post:");
		expect(html).toMatch(
			/<a[^>]*href="\/blog\/contrast-arena\/"[^>]*>The arena →<\/a>/,
		);
	});

	it("renders nothing when no post is published", async () => {
		const html = await render({});
		expect(html).not.toContain("Latest post");
		expect(html).not.toContain("<a");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/website test latest-post`
Expected: FAIL — the import of `../components/blog/LatestPost.astro` cannot be resolved.

- [ ] **Step 3: Write the component**

Create `src/components/blog/LatestPost.astro`:

```astro
---
import { type PostLike, postPath } from "../../lib/blog-posts";

interface Props {
	post?: PostLike;
}

const { post } = Astro.props;
---

{
  post && (
    <p class="latest-post">
      Latest post: <a href={postPath(post.id)}>{post.data.title} →</a>
    </p>
  )
}

<style>
  .latest-post {
    margin-top: 28px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
    letter-spacing: 0.04em;
    max-width: 560px;
    opacity: 0;
    animation: fade-up 0.6s ease forwards 1.1s;
  }

  .latest-post a {
    color: var(--text-1);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .latest-post a:hover,
  .latest-post a:focus-visible {
    color: var(--accent);
  }
</style>
```

`fade-up` is a global keyframe in `src/styles/globals.css`. `--text-1`, `--text-2` and `--accent` are existing text tokens already checked against the page surfaces, so this adds no derived surface.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/website test latest-post`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the whole website suite**

Run: `pnpm --filter @onlooker/website test`
Expected: PASS, 79 tests (77 before + 2).

- [ ] **Step 6: Commit**

Via `/git-workflow:commit` with `src/components/blog/LatestPost.astro` and `src/__tests__/latest-post.test.ts`. Body ends with `Refs ONL-267`.

---

### Task 2: Landing page copy

**Files:**
- Modify: `src/pages/index.astro` (frontmatter, `<main>` markup, `.pills`/`.pill` styles)
- Test: `src/__tests__/landing-copy.test.ts`

**Interfaces:**
- Consumes: `LatestPost.astro` (`{ post?: PostLike }`) from Task 1; `publishedPosts()` from `src/data/blog.ts` (returns published posts newest first; drafts dropped in production).
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/landing-copy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// index.astro reads astro:content, which configFile: false leaves
// unresolved, so it cannot render here. Its claims are literal text in the
// source, which is what this checks.
const page = readFileSync(
	new URL("../pages/index.astro", import.meta.url),
	"utf8",
);

// ONL-267: each of these named something that did not ship, or a count
// that had already gone stale. Putting one back should fail this test.
describe("the landing page", () => {
	for (const retired of [
		"Waypoint",
		"Playbook",
		"13+",
		"smarter than the last",
		"Learn from every failure",
		"Everything stays on your machine",
	]) {
		it(`no longer claims "${retired}"`, () => {
			expect(page).not.toContain(retired);
		});
	}

	it("points at the plugins' source", () => {
		expect(page).toContain('href="https://github.com/onlooker-community/ecosystem"');
	});

	it("links the license it claims", () => {
		expect(page).toContain(
			'href="https://github.com/onlooker-community/ecosystem/blob/main/LICENSE"',
		);
	});

	it("still posts the waitlist to the same endpoint", () => {
		expect(page).toContain("https://formsubmit.co/ajax/early@onlooker.dev");
	});

	it("shows the blog's latest post", () => {
		expect(page).toMatch(/<LatestPost post=\{posts\[0\]\} \/>/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @onlooker/website test landing-copy`
Expected: FAIL — the six retired-claim tests fail, as do the two GitHub-link tests and the LatestPost test. The endpoint test passes.

- [ ] **Step 3: Rewrite the frontmatter and `<main>`**

In `src/pages/index.astro`, replace the frontmatter with:

```astro
---
import LatestPost from "../components/blog/LatestPost.astro";
import { publishedPosts } from "../data/blog";
import Layout from "../layouts/Layout.astro";

export const prerender = true;

const posts = await publishedPosts();
---
```

Change the eyebrow line to:

```astro
    <p class="eyebrow">Hosted version coming soon</p>
```

Replace the subhead paragraph with:

```astro
    <p class="subhead">
      Onlooker is a set of open-source Claude Code plugins that watch what your
      agents do: which change wrote which line, which claims the commands
      actually back up, what a session decided before its context ran out.
      Nothing goes to an Onlooker server: what they record stays on your
      machine.
    </p>
```

Change the form note to:

```astro
      <p class="form-note">No spam. Hosted early access + launch updates only.</p>
```

Replace the whole `<div class="pills">…</div>` block with:

```astro
    <div class="pills">
      <span class="pill"><span class="pill-dot"></span>Claude Code plugins</span>
      <a
        class="pill"
        href="https://github.com/onlooker-community/ecosystem/blob/main/LICENSE"
        ><span class="pill-dot"></span>MIT licensed</a
      >
      <span class="pill"><span class="pill-dot"></span>Local-first</span>
      <a class="pill" href="https://github.com/onlooker-community/ecosystem"
        ><span class="pill-dot"></span>Source on GitHub</a
      >
    </div>

    <LatestPost post={posts[0]} />
```

Leave the `<Layout>` title unchanged and set its description to `Open-source Claude Code plugins that record what your agents do, and keep the record on your machine.` Leave the headline, the form, the success/error blocks and the `<script>` block exactly as they are.

- [ ] **Step 4: Style the linked pills**

In the page's `<style>` block, directly after the existing `.pill { … }` rule, add:

```css
  a.pill {
    text-decoration: none;
    transition: border-color 0.15s;
  }

  a.pill:hover,
  a.pill:focus-visible {
    border-color: var(--accent);
  }
```

Do not add a background to the hover state.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @onlooker/website test landing-copy`
Expected: PASS, 10 tests.

- [ ] **Step 6: Prove the retired-claims test by ablation**

With the Edit tool, change `Local-first` in the pills to `Waypoint hint engine`. Run `pnpm --filter @onlooker/website test landing-copy` and confirm exactly one failure: `no longer claims "Waypoint"`. Revert the edit with the Edit tool and confirm 10 passing. Record both outputs in your report.

- [ ] **Step 7: Run the whole suite, lint and typecheck**

Run each, from the repo root:
- `pnpm --filter @onlooker/website test` — expected PASS, 89 tests.
- `pnpm --filter @onlooker/website lint` — expected no errors.
- `pnpm --filter @onlooker/website typecheck` — expected 0 errors.

- [ ] **Step 8: Build and check the output**

Run: `pnpm --filter @onlooker/website build`
The prerendered page is `apps/website/dist/client/index.html`. Run:
- `grep -c 'href="/blog/contrast-arena/"' apps/website/dist/client/index.html` — expected `1`.
- `grep -c "Redirecting to" apps/website/dist/client/index.html` — expected `0`.

- [ ] **Step 9: Commit**

Via `/git-workflow:commit` with `src/pages/index.astro` and `src/__tests__/landing-copy.test.ts`. Body ends with `Fixes ONL-267`.

---

### Controller check (after Task 2, not a subagent task)

Run `astro preview` or `astro dev` and screenshot `/` at 360px wide in light and dark. Confirm the pills wrap, the latest-post line wraps, and the page has no horizontal scroll.
