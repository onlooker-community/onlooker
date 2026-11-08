# Reduced Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every animated block on onlooker.dev rests visible, and
`prefers-reduced-motion: reduce` turns all animation off.

**Architecture:** CSS only. Six scoped rules lose `opacity: 0` and switch to
`both` fill. `globals.css` gains one global reduced-motion rule. The website
tests' stylesheet parser moves into a shared module, and a new test uses it.

**Tech Stack:** Astro 6, plain CSS, Vitest, Biome.

Spec: `docs/superpowers/specs/2026-11-08-reduced-motion-design.md`.

## Global Constraints

* No rule that declares an `animation` declares `opacity: 0`.
* Every `fade-up` rule uses `both` fill. Keep each block's duration, easing
  and delay unchanged: `fade-up 0.6s ease both <delay>`.
* The reduced-motion rule is exactly
  `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; } }`
  in `apps/website/src/styles/globals.css`.
* Transitions are out of scope. Don't touch any `transition` declaration.
* Edit tracked files with the Edit/Write tools, never the shell.
* Run one test file with its name straight after `test` and no `--`:
  `pnpm --filter @onlooker/website test reduced-motion`.
* Commits go through `/git-workflow:commit`, in American English. Mention
  ONL-270 in the body as `Refs ONL-270`.

---

### Task 1: Animated blocks rest visible

**Files:**
- Create: `apps/website/src/__tests__/stylesheets.ts`
- Create: `apps/website/src/__tests__/reduced-motion.test.ts`
- Modify: `apps/website/src/__tests__/display-sizes.test.ts`
- Modify: `apps/website/src/pages/index.astro`, the rules `.eyebrow`,
  `.headline`, `.subhead`, `.form-wrap` and `.pills`
- Modify: `apps/website/src/components/blog/LatestPost.astro`, the rule
  `.latest-post`
- Modify: `apps/website/src/styles/globals.css`, a comment above
  `@keyframes fade-up`

**Interfaces:**
- Produces: `stylesheets.ts` exports `type Rule`, `rules(css, media?)`,
  `declared(body, property)`, and `stylesheets: Array<{ name: string; rules: Rule[] }>`.
  Each `name` is relative to `src`, for example `styles/globals.css`.

- [ ] **Step 1: Move the parser into a shared module**

Create `apps/website/src/__tests__/stylesheets.ts`. Its name doesn't end in
`.test.ts`, so Vitest doesn't collect it as a test file.

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The site's CSS as the tests read it: every .css file under src, and every
// <style> block in an .astro file, with comments stripped.

const SRC = fileURLToPath(new URL("../", import.meta.url));

export type Rule = { selector: string; body: string; media: string | null };

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

/** Top-level rules, and the rules inside @media blocks. Other at-rules are skipped. */
export function rules(css: string, media: string | null = null): Rule[] {
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
		else if (!prelude.startsWith("@"))
			out.push({ selector: prelude, body, media });
		i = close + 1;
	}
	return out;
}

export function declared(body: string, property: string): string | undefined {
	return new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`)
		.exec(body)?.[1]
		.trim();
}

/** Every stylesheet under src, named by its path relative to src. */
export const stylesheets = sources(SRC).map((path) => ({
	name: relative(SRC, path),
	rules: rules(stylesheet(path)),
}));
```

In `display-sizes.test.ts`:
* Replace the three `node:` imports with
  `import { declared, stylesheets } from "./stylesheets";`. Keep the
  `vitest` import.
* Delete `SRC`, `sources`, `stylesheet`, `Rule`, `rules`, `declared` and the
  `const files = …` block.
* Keep `DISPLAY` and the header comment. Change
  `const display = files.flatMap(` to `const display = stylesheets.flatMap(`.

Run: `pnpm --filter @onlooker/website test display-sizes`
Expected: 13 passing, the same as before the move.

- [ ] **Step 2: Write the failing test**

Create `apps/website/src/__tests__/reduced-motion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { declared, stylesheets } from "./stylesheets";

// On 2026-11-08 six blocks on the landing page started at opacity: 0 and
// relied on the fade-up animation to show them. Anything that stopped the
// animation from running, a reduced-motion rule included, left them
// invisible. Each block now rests visible and is hidden through its delay by
// fade-up's first keyframe instead, which takes `both` (or `backwards`)
// fill. With `forwards` and no opacity: 0, the block would show during its
// delay, vanish, and then fade in.

const animated = stylesheets.flatMap(({ name, rules }) =>
	rules
		.filter((rule) => declared(rule.body, "animation") !== undefined)
		.map((rule) => ({ label: `${name}: ${rule.selector}`, rule })),
);

const fadeUp = animated.filter(({ rule }) =>
	/\bfade-up\b/.test(declared(rule.body, "animation") ?? ""),
);

describe("animated blocks", () => {
	// Six use fade-up today: five on the landing page and the latest-post
	// line. Fewer found means the parser stopped seeing them.
	it("are found where the site uses them", () => {
		expect(fadeUp.length).toBeGreaterThanOrEqual(6);
	});

	for (const { label, rule } of animated) {
		it(`${label} rests visible`, () => {
			expect(declared(rule.body, "opacity")).not.toBe("0");
		});
	}

	for (const { label, rule } of fadeUp) {
		it(`${label} is hidden through its delay by the animation`, () => {
			expect(declared(rule.body, "animation")).toMatch(/\b(both|backwards)\b/);
		});
	}
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/website test reduced-motion`
Expected:
* "are found where the site uses them" passes.
* "rests visible" fails for the six rules: `pages/index.astro: .eyebrow`,
  `.headline`, `.subhead`, `.form-wrap`, `.pills`, and
  `components/blog/LatestPost.astro: .latest-post`.
* "is hidden through its delay" fails for the same six.
* "rests visible" passes for `.logo-pulse::after` and `.radar-sweep::after`.

- [ ] **Step 4: Make the blocks rest visible**

In each of the six rules, delete the `opacity: 0;` line and change
`forwards` to `both` in its `animation`. Leave the delay as it is. For
example, `.eyebrow` becomes:

```css
    margin-bottom: 32px;
    animation: fade-up 0.6s ease both 0.2s;
  }
```

The delays are: `.eyebrow` 0.2s, `.headline` 0.35s, `.subhead` 0.5s,
`.form-wrap` 0.65s, `.pills` 0.95s, and `.latest-post` 1.1s.

In `globals.css`, directly above `@keyframes fade-up`, add:

```css
/* Blocks that use this rest visible and take `both` fill: the first keyframe
 * hides them through their delay. If the animation never runs, they show. */
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test reduced-motion`, then
`pnpm --filter @onlooker/website test display-sizes`.
Expected: all pass.

- [ ] **Step 6: Prove the tests by ablation**

Make each change below, confirm it fails the named test, then restore it:
* Put `opacity: 0;` back on `.headline`. "rests visible" should fail.
* Change `.pills` back to `forwards`. "is hidden through its delay" should
  fail.

- [ ] **Step 7: Lint, typecheck and commit**

Run `pnpm --filter @onlooker/website lint` and
`pnpm --filter @onlooker/website typecheck`. If lint asks for a re-wrap, run
`pnpm --filter @onlooker/website lint:fix` and rerun the tests.

Commit with `/git-workflow:commit`. Include the seven files listed above.

---

### Task 2: Reduced motion turns animation off

**Files:**
- Modify: `apps/website/src/styles/globals.css`, at the end of the file
- Modify: `apps/website/src/__tests__/reduced-motion.test.ts`

**Interfaces:**
- Consumes: `declared` and `stylesheets` from `stylesheets.ts` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `reduced-motion.test.ts`:

```ts
// A reader who asks for less motion gets none. The rule is global, so a new
// animated block is covered without anyone remembering it. ::before and
// ::after are named because the pulsing logo ring and the radar sweep are
// both ::after.
describe("prefers-reduced-motion: reduce", () => {
	const reduce = stylesheets
		.find(({ name }) => name === "styles/globals.css")
		?.rules.find((rule) =>
			/prefers-reduced-motion:\s*reduce/.test(rule.media ?? ""),
		);

	it("turns animation off for every element and pseudo-element", () => {
		expect(reduce, "globals.css has no reduced-motion rule").toBeDefined();
		expect(reduce?.selector.split(",").map((s) => s.trim())).toEqual(
			expect.arrayContaining(["*", "*::before", "*::after"]),
		);
		expect(declared(reduce?.body ?? "", "animation")).toBe("none !important");
	});
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @onlooker/website test reduced-motion`
Expected: the new test fails on "globals.css has no reduced-motion rule".
Everything from Task 1 passes.

- [ ] **Step 3: Add the rule**

At the end of `globals.css`:

```css
/* A reader who asks for less motion gets none: no fade-ins, no pulsing logo,
 * no rotating sweep. The rule is global so the next animated block is covered
 * too, and it uses !important so it beats scoped page styles. Every animated
 * block rests visible, so turning animation off never hides anything. */
@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		animation: none !important;
	}
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/website test reduced-motion`
Expected: all pass. The new rule also shows up in the "rests visible" loop
as `styles/globals.css: *, *::before, *::after`, and passes.

- [ ] **Step 5: Prove the test by ablation**

Make each change below, confirm the new test fails, then restore it:
* Delete `*::after,` from the selector.
* Delete `!important`.

- [ ] **Step 6: Run the website suite, lint and typecheck, then commit**

Run `pnpm --filter @onlooker/website test`, `lint` and `typecheck`.
Expected: every test passes, lint is clean, and typecheck reports 0 errors.
Commit with `/git-workflow:commit`. Include both files.

---

### Task 3: Look at it (controller, not a subagent)

- [ ] Run `astro dev` and load `/`. With normal motion:
  * Right after load, `.subhead` computes opacity 0, because it is still in
    its delay.
  * After 2s, all six blocks compute opacity 1.
- [ ] In the page, copy the reduced-motion rule's declarations into a style
  element that applies unconditionally. Then check:
  * The six blocks compute `animation-name: none` and opacity 1.
  * `.logo-pulse::after` and `.radar-sweep::after` compute
    `animation-name: none`.
- [ ] Run the full `pnpm test` from the repo root.
