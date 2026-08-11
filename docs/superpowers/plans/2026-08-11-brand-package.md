# Brand Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/brand` — the cozy 16-bit token, font and icon layer —
and adopt it in `apps/website`.

**Architecture:** One package holds tokens, fonts and icons. `apps/website`
imports it and its existing class-based CSS picks up the new values. A test
parses the token file and asserts the contrast rules hold, so the palette cannot
silently regress.

**Tech Stack:** pnpm 11.0.9 workspace, vitest, biome, Astro (website).

**Spec:** `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`
**Visual reference:** <https://claude.ai/code/artifact/47220d2c-c92f-44df-b4c1-852cd4890e95>

## Global Constraints

- **Plate tokens are defined once on `:root` and NEVER inside a theme block.**
  `--plate-gold` `#ffdf40`, `--plate-teal` `#00d4aa`, `--plate-red` `#ff8a8a`,
  `--plate-ink` `#221f38`. A theme override on any of these recreates a real
  regression: dark ink on a dark plate, 1.51 contrast, day mode only.
- **Text accents DO shift per theme:** `--gold` `--teal` `--red`.
- **These three values must never appear as text colors:** `#db3a3a` (2.08 on
  panel), `#b8791a` (1.88 on panel), `#00755f` (2.94 on panel). `#db3a3a` is
  allowed only as `--mark`, for non-text use.
- **Icons render at 16, 32 or 48 only**, with `image-rendering: pixelated` and
  `flex: none`.
- **Abaddon is display and chrome only.** Body copy keeps a readable face.
  Ship `.ttf` directly — no woff2 tooling is installed and the saving is ~8KB.
- **The CC BY 4.0 icon credit is a license condition**, not a courtesy:
  Crusenho Agus Hennihuno, <https://crusenho.itch.io>.
- **Skin only.** No layout or flow changes, no markup restructuring.
- **Assets are copied into the repo**, never referenced from `~/Desktop`.
- `packages/brand` is `private: true` like every other package here. It is not
  published.
- All commits route through the `/commit` skill. American English throughout.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/brand/package.json` | package identity, exports, test script | 1 |
| `packages/brand/tokens.css` | the palette — night, day, plates | 1 |
| `packages/brand/tokens.test.ts` | asserts the contrast and plate rules | 1 |
| `packages/brand/assets.css` | `@font-face`, icon sizing rules | 2 |
| `packages/brand/fonts/*.ttf` | Abaddon Bold and Light | 2 |
| `packages/brand/icons/*.png` | 80 icons, unmodified | 2 |
| `packages/brand/ATTRIBUTION.md` | the license credits | 2 |
| `apps/website/src/styles/globals.css` | consumes the package | 3 |
| `apps/website/src/layouts/Layout.astro` | imports, attribution in footer | 3 |

Three tasks. The token layer is separable from the assets because its test is
pure computation and can be reviewed on its own; the website adoption is
separable because a reviewer could accept the package and reject how the site
uses it.

---

## Task 1: The token layer, with a test that can fail

**Files:**
- Create: `packages/brand/package.json`
- Create: `packages/brand/tokens.css`
- Create: `packages/brand/tokens.test.ts`
- Create: `packages/brand/vitest.config.ts`

**Interfaces:**
- Produces: `@onlooker/brand/tokens.css`, importable by both apps.
- Produces: the token names Task 3 consumes — `--ground --panel --edge --ink
  --ink-hi --ink-dim --gold --teal --red --mark --shadow` and the four
  `--plate-*` tokens.

- [ ] **Step 1: Create the package manifest**

Create `packages/brand/package.json`:

```json
{
	"name": "@onlooker/brand",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"exports": {
		"./tokens.css": "./tokens.css",
		"./assets.css": "./assets.css",
		"./icons/*": "./icons/*",
		"./fonts/*": "./fonts/*"
	},
	"scripts": {
		"lint": "biome check .",
		"test": "vitest run",
		"typecheck": "tsc --noEmit"
	},
	"devDependencies": {
		"@onlooker/config-biome": "workspace:*",
		"@onlooker/config-typescript": "workspace:*",
		"typescript": "^5.6.3",
		"vitest": "^4.1.9"
	}
}
```

`assets.css`, `icons/` and `fonts/` are declared here but created in Task 2.
Declaring them now keeps the manifest in one commit.

- [ ] **Step 2: Write the failing test**

Create `packages/brand/tokens.test.ts`. This is the guard the whole plan exists
to produce — it must be written before the CSS it checks.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** Pull one CSS block's body by its selector text. */
function block(selector: string): string {
	const i = css.indexOf(selector);
	if (i === -1) throw new Error(`selector not found: ${selector}`);
	const open = css.indexOf("{", i);
	let depth = 0;
	for (let j = open; j < css.length; j++) {
		if (css[j] === "{") depth++;
		if (css[j] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, j);
		}
	}
	throw new Error(`unbalanced braces after ${selector}`);
}

function tokens(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-f]{6})/g)) {
		out[m[1]] = m[2];
	}
	return out;
}

function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
	const lin = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const PLATES = ["--plate-gold", "--plate-teal", "--plate-red", "--plate-ink"];
const THEME_SELECTORS = [
	"@media (prefers-color-scheme: light)",
	':root[data-theme="light"]',
	':root[data-theme="dark"]',
];

describe("plate tokens", () => {
	it("are all defined on :root", () => {
		const root = tokens(block(":root"));
		for (const p of PLATES) expect(root[p], `${p} missing from :root`).toBeDefined();
	});

	// This is the regression guard. Overriding a plate in a theme block is what
	// produced dark ink on a dark plate at 1.51 contrast, in day mode only.
	it("are never redefined inside a theme block", () => {
		for (const sel of THEME_SELECTORS) {
			const body = block(sel);
			for (const p of PLATES) {
				expect(body.includes(p), `${p} must not appear in ${sel}`).toBe(false);
			}
		}
	});

	it("carry plate-ink at AA or better", () => {
		const t = tokens(block(":root"));
		for (const p of ["--plate-gold", "--plate-teal", "--plate-red"]) {
			expect(contrast(t[p], t["--plate-ink"]), `${p} vs --plate-ink`).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe("text accents", () => {
	const themes: Array<[string, string]> = [
		["night", ":root"],
		["day", ':root[data-theme="light"]'],
	];

	// Text lands on the ground AND on panels. Passing on one proves nothing
	// about the other, which is how three bad values reached the first review.
	for (const [name, sel] of themes) {
		for (const surface of ["--ground", "--panel"]) {
			for (const accent of ["--ink", "--gold", "--teal", "--red"]) {
				it(`${name}: ${accent} on ${surface} is at least AA-large`, () => {
					const t = tokens(block(sel));
					expect(contrast(t[accent], t[surface])).toBeGreaterThanOrEqual(3);
				});
			}
		}
		it(`${name}: --ink on --ground is at least AA`, () => {
			const t = tokens(block(sel));
			expect(contrast(t["--ink"], t["--ground"])).toBeGreaterThanOrEqual(4.5);
		});
	}
});

describe("rejected values", () => {
	// Each of these looked right in isolation and failed on the panel.
	const banned = ["#b8791a", "#00755f"];
	it("never reappear", () => {
		for (const hex of banned) expect(css).not.toContain(hex);
	});

	it("allows #db3a3a only as --mark", () => {
		for (const m of css.matchAll(/(--[a-z-]+)\s*:\s*#db3a3a/g)) {
			expect(m[1], "#db3a3a is non-text only").toBe("--mark");
		}
	});
});
```

Create `packages/brand/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["*.test.ts"] },
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
pnpm install
pnpm --filter @onlooker/brand test
```

Expected: FAIL. `tokens.css` does not exist, so `readFileSync` throws
`ENOENT`. That is the correct first failure — the test cannot pass by accident
before there is a palette to check.

- [ ] **Step 4: Write the token file**

Create `packages/brand/tokens.css`:

```css
/* Onlooker brand tokens. Derived by decoding the icon set: #464074 is the
 * art's own outline color and appears ~3x more than anything else, so it is
 * the panel and the icons sit on it natively.
 *
 * Two families, and the distinction is load-bearing:
 *   PLATES  filled backgrounds. Identical in both themes. A gold button is
 *           gold at noon and at midnight.
 *   ACCENTS ink on a ground. These shift per theme to stay legible.
 * Never redefine a --plate-* token inside a theme block. */

:root {
	/* plates: constant, never themed */
	--plate-gold: #ffdf40;
	--plate-teal: #00d4aa;
	--plate-red: #ff8a8a;
	--plate-ink: #221f38;

	/* night, the default */
	--ground: #221f38;
	--panel: #464074;
	--edge: #6b64a8;
	--ink: #d7d7f2;
	--ink-hi: #ffffff;
	--ink-dim: #9c95c2;
	--gold: #ffdf40;
	--teal: #00d4aa;
	--red: #ff8a8a;
	--mark: #db3a3a;
	--shadow: #141222;
}

/* Day is a daytime tileset, not an inversion. Same world, sun up. */
@media (prefers-color-scheme: light) {
	:root {
		--ground: #d7d7f2;
		--panel: #b8b8d9;
		--edge: #6b64a8;
		--ink: #2a2545;
		--ink-hi: #141222;
		--ink-dim: #5a5480;
		--gold: #57390c;
		--teal: #004d3e;
		--red: #8c1b25;
		--mark: #8c1b25;
		--shadow: #9c95c2;
	}
}

:root[data-theme="light"] {
	--ground: #d7d7f2;
	--panel: #b8b8d9;
	--edge: #6b64a8;
	--ink: #2a2545;
	--ink-hi: #141222;
	--ink-dim: #5a5480;
	--gold: #57390c;
	--teal: #004d3e;
	--red: #8c1b25;
	--mark: #8c1b25;
	--shadow: #9c95c2;
}

:root[data-theme="dark"] {
	--ground: #221f38;
	--panel: #464074;
	--edge: #6b64a8;
	--ink: #d7d7f2;
	--ink-hi: #ffffff;
	--ink-dim: #9c95c2;
	--gold: #ffdf40;
	--teal: #00d4aa;
	--red: #ff8a8a;
	--mark: #db3a3a;
	--shadow: #141222;
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm --filter @onlooker/brand test
```

Expected: all tests pass.

- [ ] **Step 6: Prove the plate guard can actually fail**

A guard nobody has watched fail is indistinguishable from one that cannot.
Temporarily add `--plate-gold: #57390c;` inside the
`:root[data-theme="light"]` block, then:

```bash
pnpm --filter @onlooker/brand test
```

Expected: FAIL, on `--plate-gold must not appear in :root[data-theme="light"]`.

**Remove that line and re-run to confirm green before continuing.** Then do the
same for a banned value: add `--teal: #00755f;` to the day block, confirm the
`rejected values` test fails, and remove it.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `packages/brand/package.json`,
`packages/brand/tokens.css`, `packages/brand/tokens.test.ts`,
`packages/brand/vitest.config.ts` and `pnpm-lock.yaml`.

Suggested subject: `feat(brand): add the token layer and a test that guards it :art:`

The body should explain the plate-versus-accent split and that the test exists
because the distinction was learned from a real regression, not theorized.

---

## Task 2: Fonts, icons, and the attribution

**Files:**
- Create: `packages/brand/fonts/abaddon-bold.ttf`, `packages/brand/fonts/abaddon-light.ttf`
- Create: `packages/brand/icons/` (80 png files)
- Create: `packages/brand/assets.css`
- Create: `packages/brand/ATTRIBUTION.md`
- Create: `packages/brand/assets.test.ts`

**Interfaces:**
- Consumes: `packages/brand/package.json` from Task 1, which already declares
  the `./assets.css`, `./icons/*` and `./fonts/*` exports.
- Produces: `@onlooker/brand/assets.css` and the classes `.pixel-icon`,
  `.pixel-icon--16`, `.pixel-icon--32`, `.pixel-icon--48`, which Task 3 uses.

- [ ] **Step 1: Copy the assets into the repo**

```bash
mkdir -p packages/brand/fonts packages/brand/icons
cp ~/Desktop/"Onlooker Assets"/Abaddon_Fonts_v1.2/"Abaddon Bold.ttf" packages/brand/fonts/abaddon-bold.ttf
cp ~/Desktop/"Onlooker Assets"/Abaddon_Fonts_v1.2/"Abaddon Light.ttf" packages/brand/fonts/abaddon-light.ttf
cp ~/Desktop/"Onlooker Assets"/Icons_Essential/v1.2/Icons/*.png packages/brand/icons/
ls packages/brand/icons/*.png | wc -l
```

Expected: `80`. If it is not 80, stop and report — the icon set is meant to be
complete and a partial copy would silently ship a broken set.

- [ ] **Step 2: Write the failing asset test**

Create `packages/brand/assets.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const iconDir = new URL("./icons/", import.meta.url);

/** Read width and height out of a PNG's IHDR chunk. */
function pngSize(path: URL): { w: number; h: number } {
	const buf = readFileSync(path);
	return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("icons", () => {
	const files = readdirSync(iconDir).filter((f) => f.endsWith(".png"));

	it("are all present", () => {
		expect(files).toHaveLength(80);
	});

	// Non-integer scaling destroys pixel art. The whole size system depends on
	// every source being exactly 16x16.
	it("are every one exactly 16x16", () => {
		for (const f of files) {
			const { w, h } = pngSize(new URL(f, iconDir));
			expect({ f, w, h }).toEqual({ f, w: 16, h: 16 });
		}
	});

	it("include the ones the brand relies on by name", () => {
		for (const n of ["Eye", "MagnifyingGlass", "Lightbulb", "Locked", "Unlocked",
			"Team", "Skull", "Trophy", "ChestTreasure"]) {
			expect(files, `${n}.png missing`).toContain(`${n}.png`);
		}
	});
});

describe("fonts", () => {
	it("are present and are TrueType", () => {
		for (const f of ["abaddon-bold.ttf", "abaddon-light.ttf"]) {
			const buf = readFileSync(new URL(`./fonts/${f}`, import.meta.url));
			expect(buf.length, `${f} is empty`).toBeGreaterThan(1000);
			// TrueType outlines start with 0x00010000.
			expect(buf.readUInt32BE(0), `${f} is not a TTF`).toBe(0x00010000);
		}
	});
});

describe("attribution", () => {
	const doc = readFileSync(new URL("./ATTRIBUTION.md", import.meta.url), "utf8");

	// CC BY 4.0 requires the credit to travel with the work.
	it("names the icon author and links the license", () => {
		expect(doc).toContain("Crusenho Agus Hennihuno");
		expect(doc).toContain("creativecommons.org/licenses/by/4.0");
	});

	it("names the font license", () => {
		expect(doc).toContain("creativecommons.org/licenses/by/3.0");
	});
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @onlooker/brand test
```

Expected: the `attribution` suite fails — `ATTRIBUTION.md` does not exist yet.
The icon and font suites should already pass from Step 1's copy.

- [ ] **Step 4: Write the attribution**

Create `packages/brand/ATTRIBUTION.md`:

```markdown
# Third-party assets

## Icons

80 pixel icons by **Crusenho Agus Hennihuno** — <https://crusenho.itch.io>

Licensed **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/>

Attribution is a condition of this license. The credit must appear wherever the
icons are displayed — the website footer and the app's about surface at minimum.
A line in this file alone does not satisfy it, because nobody renders this file.

Unmodified.

## Fonts

**Abaddon** (Light, Bold) — licensed **CC BY 3.0**,
<https://creativecommons.org/licenses/by/3.0/>

Free to use, attribution appreciated but not required, no reselling of the font
or derivatives. Unmodified.
```

- [ ] **Step 5: Write the asset stylesheet**

Create `packages/brand/assets.css`:

```css
/* Fonts and icon rendering. Import after tokens.css. */

@font-face {
	font-family: "Abaddon";
	font-style: normal;
	font-weight: 700;
	src: url("./fonts/abaddon-bold.ttf") format("truetype");
	/* block, not swap: a pixel face swapping in mid-read is far more jarring
	 * than a normal webfont swap. */
	font-display: block;
}

@font-face {
	font-family: "Abaddon";
	font-style: normal;
	font-weight: 400;
	src: url("./fonts/abaddon-light.ttf") format("truetype");
	font-display: block;
}

:root {
	/* Display and chrome only. Body copy keeps a readable face - pixel type is
	 * measurably harder to read at length. */
	--font-display: "Abaddon", ui-monospace, monospace;
	--font-body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--font-data: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

/* Sources are 16x16. Only integer multiples render cleanly; anything between
 * turns the art to mush, so the size system offers exactly three steps. */
.pixel-icon {
	image-rendering: pixelated;
	display: block;
	/* In a column flex container the main axis is vertical, so a wrapping
	 * caption below an icon will silently squash it. Do not remove. */
	flex: none;
}

.pixel-icon--16 { width: 16px; height: 16px; }
.pixel-icon--32 { width: 32px; height: 32px; }
.pixel-icon--48 { width: 48px; height: 48px; }
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm --filter @onlooker/brand test
pnpm --filter @onlooker/brand lint
```

Expected: all suites pass, lint exits 0.

- [ ] **Step 7: Prove the 16x16 guard can fail**

```bash
cp packages/brand/icons/Eye.png /tmp/Eye.png.bak
cp ~/Desktop/"Onlooker Assets"/PlayfulFree/free.png packages/brand/icons/Eye.png
pnpm --filter @onlooker/brand test
```

Expected: FAIL, reporting `Eye.png` as 192×176 rather than 16×16.

Restore and confirm green:

```bash
cp /tmp/Eye.png.bak packages/brand/icons/Eye.png && rm /tmp/Eye.png.bak
pnpm --filter @onlooker/brand test
git status --short packages/brand/icons/
```

Expected: tests pass and `git status` shows no modification to `Eye.png`.

- [ ] **Step 8: Commit**

Use the `/commit` skill with `packages/brand/fonts/`, `packages/brand/icons/`,
`packages/brand/assets.css`, `packages/brand/ATTRIBUTION.md` and
`packages/brand/assets.test.ts`.

Suggested subject: `feat(brand): vendor the fonts and icons with their licenses :framed_picture:`

The body should record that attribution is a license condition rather than a
courtesy, and that the icons are unmodified.

---

## Task 3: The website adopts it

**Files:**
- Modify: `apps/website/package.json`
- Modify: `apps/website/src/styles/globals.css:9-23`
- Modify: `apps/website/src/layouts/Layout.astro`

**Interfaces:**
- Consumes: `@onlooker/brand/tokens.css` and `@onlooker/brand/assets.css` from
  Tasks 1 and 2, and the token names they define.

The website's CSS is class-based — `section`, `section-heading`, `pill`,
`eyebrow`, `prose`, `code-block` — in a single 258-line file imported once from
`Layout.astro`. Replacing the token block at the top updates every class at once.
**Do not restructure any class or any markup.**

- [ ] **Step 1: Add the dependency**

In `apps/website/package.json`, add to `dependencies`:

```json
"@onlooker/brand": "workspace:*"
```

Then:

```bash
pnpm install
```

- [ ] **Step 2: Replace the token block**

In `apps/website/src/styles/globals.css`, replace the whole `:root { … }` block
at lines 9-23 with imports. The two `@import` lines must be the first statements
in the file — CSS requires `@import` to precede all other rules.

Delete this:

```css
:root {
	--bg: #080c10;
	--bg-2: #0d1520;
	--bg-3: #111d2e;
	--border: rgba(255, 255, 255, 0.07);
	--border-2: rgba(255, 255, 255, 0.12);
	--accent: #00d4aa;
	--accent-dim: rgba(0, 212, 170, 0.15);
	--accent-glow: rgba(0, 212, 170, 0.06);
	--text-1: #e8edf2;
	--text-2: #8a9ab0;
	--text-3: #4a5a6e;
	--mono: "DM Mono", monospace;
	--sans: "Syne", sans-serif;
}
```

Add at the very top of the file, above the `*` reset:

```css
@import "@onlooker/brand/tokens.css";
@import "@onlooker/brand/assets.css";
```

And add, after the reset, a compatibility block mapping the old names onto the
new tokens so no existing rule breaks:

```css
/* The old names, pointed at the new tokens. Every existing rule in this file
 * uses them, so this maps the whole stylesheet over in one place rather than
 * touching ~200 lines of unrelated declarations. */
:root {
	--bg: var(--ground);
	--bg-2: var(--panel);
	--bg-3: var(--panel);
	--border: var(--edge);
	--border-2: var(--edge);
	--accent: var(--teal);
	--accent-dim: color-mix(in srgb, var(--teal) 15%, transparent);
	--accent-glow: color-mix(in srgb, var(--teal) 6%, transparent);
	--text-1: var(--ink-hi);
	--text-2: var(--ink);
	--text-3: var(--ink-dim);
	--mono: var(--font-data);
	--sans: var(--font-display);
}
```

- [ ] **Step 3: Verify the site builds and renders**

```bash
pnpm --filter @onlooker/website build
```

Expected: build succeeds.

Then run it and look at it:

```bash
pnpm --filter @onlooker/website dev
```

Open the local URL. Expected: the site is now indigo-grounded with gold headings,
its layout completely unchanged. Toggle your OS between light and dark and
confirm both are legible — day is a lighter lavender ground, not an inversion.

**If any text is hard to read, stop and report it** rather than adjusting a
token locally. The palette is contract-tested in Task 1; a readability problem
here means the mapping above is wrong, not the palette.

- [ ] **Step 4: Add the attribution to the footer**

In `apps/website/src/layouts/Layout.astro`, add inside the existing footer
element:

```html
<p class="credit">
	Icons by <a href="https://crusenho.itch.io">Crusenho Agus Hennihuno</a>,
	<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
</p>
```

If `Layout.astro` has no footer element, add the paragraph as the last child of
`<body>` instead, and report that you did so — the credit must be visible on
every page that renders an icon, and this layout wraps them all.

Add to `globals.css`:

```css
.credit {
	font-family: var(--font-data);
	font-size: 12px;
	color: var(--ink-dim);
}

.credit a {
	color: var(--teal);
}
```

- [ ] **Step 5: Verify the credit renders**

```bash
pnpm --filter @onlooker/website build
grep -rl "Crusenho" apps/website/dist/ | head -3
```

Expected: at least one built HTML file contains the credit. **A credit that
exists only in source does not satisfy the license** — it has to reach the
rendered page.

- [ ] **Step 6: Run the full gates**

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: all green.

- [ ] **Step 7: Commit**

Use the `/commit` skill with `apps/website/package.json`,
`apps/website/src/styles/globals.css`, `apps/website/src/layouts/Layout.astro`
and `pnpm-lock.yaml`.

Suggested subject: `feat(website): adopt the shared brand tokens :art:`

The body should explain that the old token names were mapped onto the new ones
rather than rewriting every rule, and that the icon credit is a license
condition that must render.

---

## Definition of Done

- `pnpm --filter @onlooker/brand test` passes, and both the plate-override guard
  and the 16×16 guard have been **observed failing** and then restored
- `packages/brand/icons/` contains exactly 80 files, every one 16×16
- The website builds, renders in the new palette with its layout unchanged, and
  is legible in both day and night
- The icon credit appears in built HTML, not only in source
- `pnpm build && pnpm test && pnpm lint` all green

## Not in this plan

**`apps/web`.** It has no styling layer at all — 71 inline `style={{…}}` props
across nine pages, no CSS files, no classNames. Pointing those at `var(--token)`
is still skin-only work, but it is a different kind of job and gets its own plan
once this package exists.

**PlayfulFree sprites.** The 192×176 sheet needs slicing and nine-slice scaling
for variable-width buttons. CSS plates get most of the effect for now.

**Click SFX.** That pack shipped with no license file at all. Blocked until the
itch.io page is checked, and it would need a mute control and a persisted
preference before it could ship.

**Structural game screens.** A lesson pool as an inventory, a tribunal screen.
Fits the domain, but it is a product redesign and this is a rebrand.
