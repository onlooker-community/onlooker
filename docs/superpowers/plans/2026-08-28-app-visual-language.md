# App Visual Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` the visual language `packages/brand` already defines — icons, scales, a legal display face, and a lawful attribution surface — and apply it to `/lessons` and `/machines`.

**Architecture:** Two scales and an icon-name union land in `packages/brand` so future screens inherit them. `apps/web` gains a thin `Icon` wrapper over the shared PNGs and a shared `ConfirmAction` that owns the arm-then-confirm flow both destructive pages duplicate. The display face is corrected to its only legal sizes everywhere it appears, guarded by a source-level test so it cannot rot again. Then the two screens are restyled.

**Tech Stack:** React 18, react-router-dom 6, TypeScript with `moduleResolution: "bundler"`, Vite 8, Vitest + @testing-library/react (jsdom), CSS custom properties in `packages/brand`.

## Global Constraints

- **American English** in every comment, identifier and user-facing string: `color`, `behavior`, `normalize`, `canceled`, `analyze`.
- Commits go through the `/commit` skill. Format: `<type>(<scope>): <subject> :emoji:`, subject ≤72 chars including the emoji, why-focused body wrapped at 80, mood emoji reflecting *this* change rather than the type label, body ending `Refs: onlooker-ss1`.
- **Branch and PR, never a direct push to `main`.** Work happens on `feat/app-visual-language`, which already carries the spec.
- Never `git add -A` or `git add .` — stage intentionally.
- **Icons render at 16, 32 or 48 only.** Never between. Non-integer scaling destroys pixel art.
- **The display face (`--font-display`, Abaddon) is legal at 16, 32 and 48px only.** Measured: `unitsPerEm` 1024, GCD of every glyph coordinate 64, so one pixel is 64 units and the design size is 16px.
- **Plates are filled backgrounds and constant across themes; accents are ink on a ground and shift.** One key cannot be both. Never redefine a `--plate-*` inside a theme block.
- **Behavior does not change** except where a task says so explicitly. Every existing test should still pass; one that needs its assertion changed is a signal to stop and look.
- Gates from the repo root: `pnpm test`, `pnpm typecheck`, `pnpm lint`. All three green before every commit.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/brand/index.ts` | The `IconName` union. Type-only, so no build step and no runtime export. |
| `apps/web/src/components/Icon.tsx` | Resolves an `IconName` to a URL and renders it at a legal size. |
| `apps/web/src/components/ConfirmAction.tsx` | The arm-then-confirm flow, with focus management, shared by retract and revoke. |
| `apps/web/src/__tests__/icon.test.tsx` | Icon rendering and size legality. |
| `apps/web/src/__tests__/display-face.test.ts` | Source-level guard: no illegal `--font-display` size anywhere. |
| `apps/web/src/__tests__/confirm-action.test.tsx` | Focus retention, focus movement, `aria-describedby`. |

**Modified:**

| File | Change |
|---|---|
| `packages/brand/tokens.css` | Add `--space-*` and the three type scales. |
| `packages/brand/package.json` | Add the `"."` export so `IconName` resolves. |
| `packages/brand/tokens.test.ts` | Pin the scales, including that display steps are exactly 16/32/48. |
| `packages/brand/assets.test.ts` | Pin that the union matches the icon directory. |
| `docs/superpowers/specs/2026-08-11-brand-16bit-design.md` | Record `Restart` for superseded and the measured 16px design size. |
| `apps/web/src/vite-env.d.ts` | Type `import.meta.glob`. |
| `apps/web/src/components/ui.tsx` | Legal type sizes; `Button` pending stops using `disabled`; `StatusBadge` gains an icon. |
| `apps/web/src/components/AppShell.tsx` | Legal type sizes (Task 3); attribution footer (Task 5); wordmark and nav icons (Task 6 Step 4b). |
| `apps/web/src/components/form.tsx`, `ErrorBoundary.tsx`, `SessionExpiryBanner.tsx`, `TokenReveal.tsx` | Display-face correction only. |
| `apps/web/src/pages/SettingsPage.tsx`, `ResetPasswordPage.tsx` | Display-face correction only. |
| `apps/web/src/pages/LessonsPage.tsx`, `LessonDetail.tsx`, `MachinesPage.tsx` | Full treatment. |

**Not touched:** `apps/website`. `packages/brand/assets.css` — `.pixel-icon` and its three size classes already exist and are correct.

---

## Notes for whoever builds this

**Read the file before editing it.** `LessonsPage.tsx`, `LessonDetail.tsx` and `MachinesPage.tsx` went through several review-driven fix rounds in `onlooker-yfw` and carry race guards (`requestSeq`, `currentId`, a mirror effect, a reset effect) whose comments explain non-obvious orderings. None of that is yours to change. If a styling edit seems to require touching one, stop and report it.

**The existing brand tests will not notice your scale tokens.** `tokens.test.ts`'s parser matches `#[0-9a-f]{6}` only, so `--space-1: 4px` is invisible to the twins check that compares theme blocks. Adding scales to `:root` alone is safe, and Task 1 adds its own assertions rather than relying on the old ones.

**No test anywhere asserts on `fontSize` or `fontFamily`.** That is why the display face could be wrong in nine files. Task 3 adds the guard that was missing.

---

### Task 1: The scales, and two corrections to the brand doc

**Files:**
- Modify: `packages/brand/tokens.css`, `packages/brand/tokens.test.ts`, `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`

**Interfaces:**
- Produces: `--space-1` … `--space-7`; `--text-display-md|lg|xl`; `--text-body-sm|md|lg`; `--text-data-sm|md`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

Append to `packages/brand/tokens.test.ts`:

```ts
/** Scale tokens carry lengths, not hex, so `tokens()` above cannot see them. */
function lengths(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of body.matchAll(/(--[a-z-]+(?:-[a-z0-9]+)?)\s*:\s*([0-9.]+(?:px|rem))/g)) {
		out[m[1]] = m[2];
	}
	return out;
}

describe("scales", () => {
	const root = lengths(block(":root"));

	it("declares a 4px spacing scale", () => {
		expect(Object.entries(root).filter(([k]) => k.startsWith("--space-"))).toEqual([
			["--space-1", "4px"],
			["--space-2", "8px"],
			["--space-3", "12px"],
			["--space-4", "16px"],
			["--space-5", "24px"],
			["--space-6", "32px"],
			["--space-7", "48px"],
		]);
	});

	// The whole point. Abaddon's design size is 16px - unitsPerEm 1024, and the
	// GCD of every glyph coordinate is 64, so one pixel is 64 units. A pixel
	// face renders crisply only at its design size and integer multiples, so
	// these three are the only legal display sizes and there must be no fourth.
	it("offers exactly three display steps, all integer multiples of 16px", () => {
		const display = Object.entries(root).filter(([k]) =>
			k.startsWith("--text-display-"),
		);
		expect(display).toHaveLength(3);
		for (const [name, value] of display) {
			const px = Number.parseInt(value, 10);
			expect(value, `${name} must be px, not rem`).toMatch(/px$/);
			expect(px % 16, `${name} is ${value}, not a multiple of 16px`).toBe(0);
		}
	});

	// Body copy is the opposite case: it must respect a reader's font-size
	// preference, which px would ignore.
	it("sizes body and data copy in rem", () => {
		for (const [name, value] of Object.entries(root)) {
			if (name.startsWith("--text-body-") || name.startsWith("--text-data-")) {
				expect(value, `${name} must be rem, not px`).toMatch(/rem$/);
			}
		}
	});

	it("keeps the scales off the theme blocks", () => {
		for (const sel of THEME_SELECTORS) {
			const body = block(sel);
			expect(body).not.toMatch(/--space-/);
			expect(body).not.toMatch(/--text-/);
		}
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/brand exec vitest run tokens.test.ts`
Expected: FAIL — the spacing assertion gets `[]` because no `--space-*` exists yet.

- [ ] **Step 3: Add the scales**

In `packages/brand/tokens.css`, inside the `:root` block, after the plates and before the night palette:

```css
	/* Scales. Declared once on :root and never inside a theme block - a step is
	 * a measurement, not a color, and nothing about it changes when the sun
	 * comes up. Same rule the plates follow, for a different reason. */

	/* 4px base, shared with the icon grid so a 16px icon lands on a step
	 * rather than near one. */
	--space-1: 4px;
	--space-2: 8px;
	--space-3: 12px;
	--space-4: 16px;
	--space-5: 24px;
	--space-6: 32px;
	--space-7: 48px;

	/* Abaddon's design size is 16px: unitsPerEm is 1024 and the greatest
	 * common divisor of every glyph coordinate is 64, so one pixel is 64
	 * units. A pixel face renders crisply only at its design size and integer
	 * multiples, so these three are the only legal display sizes - there is
	 * deliberately no smaller step. Small chrome uses --text-data-* instead.
	 *
	 * px rather than rem, and that is a real tradeoff: rem would follow a
	 * reader's font-size preference and land the face on a fractional
	 * multiple, which is the one thing that destroys it. Browser zoom still
	 * scales these; a root font-size preference does not. */
	--text-display-md: 16px;
	--text-display-lg: 32px;
	--text-display-xl: 48px;

	/* Body copy in rem, so it does follow the reader's preference. */
	--text-body-sm: 0.8rem;
	--text-body-md: 0.95rem;
	--text-body-lg: 1.25rem;

	/* Monospace, for the small uppercase chrome the display face is too large
	 * for. Also rem. */
	--text-data-sm: 0.7rem;
	--text-data-md: 0.8rem;
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm --filter @onlooker/brand exec vitest run tokens.test.ts`
Expected: PASS, including every pre-existing assertion.

- [ ] **Step 5: Correct the brand doc**

In `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`, in the Typography section, after the paragraph beginning "Body copy stays in a readable face", add:

```markdown
**Abaddon's design size is 16px.** Measured from the font: `unitsPerEm` is 1024
and the greatest common divisor of every glyph coordinate across 95 sampled
glyphs is 64, so one pixel is 64 units. The face is therefore legal at **16, 32
and 48 only** — the same grid the icons sit on. This was left unnamed in the
original draft, which is how `apps/web` came to use the face at 24, 14, 13, 12
and 11px across nine files without anything noticing. Corrected in
`onlooker-ss1`.
```

In the Icons section, extend the mapping paragraph so it ends:

```markdown
is a failure; ChestTreasure is the approved pool; Trophy is promotion; Restart
is a superseded lesson — the claim run again rather than thrown away, which is
why it is not Trashbin.
```

- [ ] **Step 6: Run the full gates**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green.

- [ ] **Step 7: Commit**

Use `/commit`. Stage exactly:

```bash
git add packages/brand/tokens.css packages/brand/tokens.test.ts docs/superpowers/specs/2026-08-11-brand-16bit-design.md
```

Subject: `feat(brand): give the app a scale it can build on :straight_ruler:`
Body: why the display steps are px while body copy is rem, and that the design size was measured rather than assumed.

---

### Task 2: The icon name union and the `Icon` component

**Files:**
- Create: `packages/brand/index.ts`, `apps/web/src/components/Icon.tsx`, `apps/web/src/__tests__/icon.test.tsx`
- Modify: `packages/brand/package.json`, `packages/brand/assets.test.ts`, `apps/web/src/vite-env.d.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type IconName` from `@onlooker/brand`; `<Icon name={IconName} size?: 16 | 32 | 48 />` from `../components/Icon`. Tasks 5, 6 and 7 consume both.

- [ ] **Step 1: Write the failing tests**

Append to `packages/brand/assets.test.ts`:

```ts
import { ICON_NAMES } from "./index";

// The union exists so a typo fails at compile time instead of 404ing at
// runtime. That only holds while it matches what is actually on disk, and
// nothing else would notice a file being added or renamed.
describe("the icon name union", () => {
	it("lists exactly the files in the directory", () => {
		const onDisk = readdirSync(iconDir)
			.filter((f) => f.endsWith(".png"))
			.map((f) => f.replace(/\.png$/, ""))
			.sort();
		expect([...ICON_NAMES].sort()).toEqual(onDisk);
	});
});
```

Create `apps/web/src/__tests__/icon.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../components/Icon";

describe("Icon", () => {
	// The glob is the whole mechanism. If it resolves nothing, every icon in
	// the app renders as a broken image and no other test would say so.
	it("resolves a real URL for a known icon", () => {
		render(<Icon name="Eye" />);
		const img = screen.getByRole("presentation");
		expect(img.getAttribute("src")).toBeTruthy();
		expect(img.getAttribute("src")).not.toBe("");
	});

	it("renders at 16 by default and carries the pixel-icon classes", () => {
		render(<Icon name="Key" />);
		const img = screen.getByRole("presentation");
		expect(img.className).toContain("pixel-icon");
		expect(img.className).toContain("pixel-icon--16");
	});

	it("takes the other two legal sizes", () => {
		const { rerender } = render(<Icon name="Trophy" size={32} />);
		expect(screen.getByRole("presentation").className).toContain("pixel-icon--32");
		rerender(<Icon name="Trophy" size={48} />);
		expect(screen.getByRole("presentation").className).toContain("pixel-icon--48");
	});

	// Decorative by default: the label beside an icon already says what it
	// means, and a screen reader announcing both reads it twice.
	it("is hidden from assistive tech unless given a label", () => {
		const { rerender } = render(<Icon name="Skull" />);
		expect(screen.getByRole("presentation").getAttribute("alt")).toBe("");
		rerender(<Icon name="Skull" label="Refuted" />);
		expect(screen.getByRole("img", { name: "Refuted" })).toBeDefined();
	});
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @onlooker/brand exec vitest run assets.test.ts
pnpm --filter @onlooker/web exec vitest run src/__tests__/icon.test.tsx
```

Expected: both FAIL to resolve their imports — `./index` and `../components/Icon` do not exist.

- [ ] **Step 3: Create the union**

Create `packages/brand/index.ts`. The union has 80 members; generate them rather than typing them, then paste the result:

```bash
ls packages/brand/icons | sed 's/\.png$//' | sort | awk '{printf "\t\"%s\",\n", $0}'
```

```ts
/**
 * Every icon in `icons/`, as a value and a type.
 *
 * A union rather than `string` so `<Icon name="Lightbolb" />` fails at compile
 * time instead of 404ing in front of a user. Kept honest by a test in
 * assets.test.ts that compares this list against the directory - without it,
 * adding a PNG and forgetting this file produces a name nobody can use, and
 * renaming one produces a type that lies.
 *
 * Type-only consumers get erased at build, so this file needs no bundling.
 */
export const ICON_NAMES = [
	"Backpack",
	"Basket",
	// ...all 80, alphabetically, from the command above
	"Wrench3",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
```

Add the export to `packages/brand/package.json`, as the first entry in `exports`:

```json
		".": "./index.ts",
```

`moduleResolution` is `"bundler"` across the workspace, which resolves a TypeScript source entry directly — no build step, no `dist`.

- [ ] **Step 4: Type `import.meta.glob`**

`apps/web/src/vite-env.d.ts` hand-rolls `ImportMetaEnv` rather than referencing `vite/client`. Do **not** add that reference — Vite declares `MODE: string` where this file declares `MODE?: string`, and the duplicate members conflict. Extend the existing interface instead:

```ts
interface ImportMeta {
	readonly env: ImportMetaEnv;
	/**
	 * Declared narrowly here rather than by pulling in `vite/client`, whose
	 * ImportMetaEnv conflicts with the hand-rolled one above on MODE's
	 * optionality.
	 */
	glob<T = unknown>(
		pattern: string,
		options?: { eager?: boolean; query?: string; import?: string },
	): Record<string, T>;
}
```

- [ ] **Step 5: Write the component**

Create `apps/web/src/components/Icon.tsx`:

```tsx
import type { IconName } from "@onlooker/brand";

/**
 * A brand icon, at one of the three sizes it is legal to render.
 *
 * The sources are 16x16 and only integer multiples render cleanly - anything
 * between turns the art to mush - so `size` is a union of exactly those three
 * rather than a number. `packages/brand/assets.css` supplies `.pixel-icon` and
 * the size classes, including a `flex: none` that must not be removed: in a
 * column flex container a wrapping caption silently squashes the icon.
 *
 * The brand doc says each app wraps the shared assets in its own thin
 * component, because the asset pipeline differs per framework. This is
 * apps/web's.
 */

// A relative glob rather than a bare specifier: Vite's import.meta.glob does
// not accept package names, only paths it can walk at build time. The path is
// stable because the monorepo layout is, and the test asserts it resolved.
const URLS = import.meta.glob<string>(
	"../../../../packages/brand/icons/*.png",
	{ eager: true, query: "?url", import: "default" },
);

function urlFor(name: IconName): string {
	const match = Object.entries(URLS).find(([path]) =>
		path.endsWith(`/${name}.png`),
	);
	return match ? match[1] : "";
}

export function Icon({
	name,
	size = 16,
	label,
}: {
	name: IconName;
	size?: 16 | 32 | 48;
	/**
	 * Only pass this when the icon is the sole carrier of its meaning. Beside a
	 * visible label it is decoration, and announcing both reads the same thing
	 * twice.
	 */
	label?: string;
}) {
	return (
		<img
			src={urlFor(name)}
			className={`pixel-icon pixel-icon--${size}`}
			width={size}
			height={size}
			alt={label ?? ""}
			role={label ? undefined : "presentation"}
		/>
	);
}
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm --filter @onlooker/brand exec vitest run assets.test.ts
pnpm --filter @onlooker/web exec vitest run src/__tests__/icon.test.tsx
```

Expected: PASS. **If the URL assertion fails, the glob path is wrong — do not weaken the assertion.** Count the directory levels from `apps/web/src/components/` to the repo root and correct the pattern; that test is the only thing standing between this and 80 broken images.

- [ ] **Step 7: Import the brand CSS**

`apps/web/src/main.tsx` already imports `@onlooker/brand/assets.css`. Confirm it, since `.pixel-icon` comes from there and nothing else supplies it.

- [ ] **Step 8: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add packages/brand/index.ts packages/brand/package.json packages/brand/assets.test.ts apps/web/src/components/Icon.tsx apps/web/src/vite-env.d.ts apps/web/src/__tests__/icon.test.tsx
```

Subject: `feat(brand): put the icon set within reach :framed_picture:`
Body: why the union is generated and tested against the directory, and why the glob is a relative path.

---

### Task 3: The display-face correction, everywhere it is wrong

**Files:**
- Create: `apps/web/src/__tests__/display-face.test.ts`
- Modify: `apps/web/src/components/ui.tsx`, `AppShell.tsx`, `form.tsx`, `ErrorBoundary.tsx`, `SessionExpiryBanner.tsx`, `TokenReveal.tsx`; `apps/web/src/pages/SettingsPage.tsx`, `ResetPasswordPage.tsx`, `LessonsPage.tsx`, `LessonDetail.tsx`

**Interfaces:**
- Consumes: `--text-display-*` and `--text-data-*` from Task 1.
- Produces: nothing later tasks import.

**The rule:** `--font-display` may only be paired with `var(--text-display-md|lg|xl)`. Every other current use moves to `var(--font-data)` at a `--text-data-*` size. Uppercase monospace at 11–12px keeps the technical register those labels want without mushing a pixel face to get it.

- [ ] **Step 1: Write the guard test**

Create `apps/web/src/__tests__/display-face.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Abaddon's design size is 16px, so the face is legal at 16/32/48 only. This
// is a source-level check on purpose: no rendering test can see a font size,
// which is exactly how the app came to use the face at 24, 14, 13, 12 and 11px
// across nine files without a single one of 271 tests noticing.
const SRC = new URL("../", import.meta.url).pathname;
const LEGAL = ["var(--text-display-md)", "var(--text-display-lg)", "var(--text-display-xl)"];

// components/ and pages/ only, deliberately. Scanning all of src/ would sweep
// in this file, whose own source contains both the string it greps for and a
// `fontSize:` regex two lines later - so the guard would report itself as an
// offender at a size it invented from its own source code.
const ROOTS = ["components", "pages"];

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) return sources(p);
		return /\.tsx?$/.test(entry) ? [p] : [];
	});
}

describe("the display face", () => {
	it("is never paired with a size that is not an integer multiple of 16px", () => {
		const offenders: string[] = [];
		for (const file of ROOTS.flatMap((r) => sources(join(SRC, r)))) {
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			lines.forEach((line, i) => {
				if (!line.includes("var(--font-display)")) return;
				// The fontSize sits within a few lines of the fontFamily in every
				// existing call site; widen the window rather than the rule if
				// that ever stops being true.
				const window = lines.slice(i, i + 6).join("\n");
				const size = /fontSize:\s*"?([^",\n]+)"?/.exec(window);
				if (!size) return;
				if (!LEGAL.includes(size[1].trim())) {
					offenders.push(`${file.replace(SRC, "")}:${i + 1} -> ${size[1].trim()}`);
				}
			});
		}
		expect(offenders, "display face at an illegal size").toEqual([]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/display-face.test.ts`
Expected: FAIL, listing 17 offenders across 10 files.

- [ ] **Step 3: Correct the three legal sites**

These already render at 16px and only need the token. Replace `fontSize: "16px"` with `fontSize: "var(--text-display-md)"` at:

- `apps/web/src/components/AppShell.tsx` — the `Onlooker` wordmark
- `apps/web/src/components/TokenReveal.tsx` — the dialog heading
- `apps/web/src/components/ui.tsx` — `EmptyState`'s `h2`

- [ ] **Step 4: Move every illegal site to the data face**

For each site below, replace `fontFamily: "var(--font-display)"` with `fontFamily: "var(--font-data)"` and the `fontSize` with the token named. Leave `letterSpacing` and `textTransform` exactly as they are — the uppercase treatment is what carries the register, and it survives the face change.

| File | What it is | New size token |
|---|---|---|
| `ui.tsx` | `StatusBadge` label (11px) | `var(--text-data-sm)` |
| `ui.tsx` | `Panel` title `h2` (14px) | `var(--text-data-md)` |
| `ui.tsx` | `Button` label (13px) | `var(--text-data-md)` |
| `AppShell.tsx` | nav links (13px) | `var(--text-data-md)` |
| `AppShell.tsx` | sign-out button (13px) | `var(--text-data-md)` |
| `SessionExpiryBanner.tsx` | banner label (12px) | `var(--text-data-md)` |
| `form.tsx` | `AuthCard` heading (24px) | `var(--text-body-lg)` — see note |
| `form.tsx` | `SubmitButton` label (14px) | `var(--text-data-md)` |
| `ErrorBoundary.tsx` | fallback heading (24px) | `var(--text-body-lg)` — see note |
| `ErrorBoundary.tsx` | two labels (14px, ×2) | `var(--text-data-md)` |
| `SettingsPage.tsx` | two section headings (14px, ×2) | `var(--text-data-md)` |
| `ResetPasswordPage.tsx` | heading (14px) | `var(--text-data-md)` |
| `LessonsPage.tsx` | filter label (12px) | `var(--text-data-sm)` |
| `LessonDetail.tsx` | `Field` label (12px) | `var(--text-data-sm)` |

**The two 24px headings were decided rather than left to you.** `AuthCard`'s title and `ErrorBoundary`'s fallback heading are the largest display type in the app. 24px is 1.5× the design size and illegal; the nearest legal display steps are 32px (large for a login card we agreed not to redesign) and 16px (which would drop a page heading below its own body copy and invert the hierarchy).

Both move to **`var(--font-body)` at `var(--text-body-lg)`** — 1.25rem, 20px. Closest to what is there now, still unmistakably a heading, and in rem so it follows the reader's font-size preference. They lose the pixel face, and that is the intended trade: the login screen is the first thing anyone reads and the error screen is read under stress, which is exactly where the brand doc says a pixel face is the wrong choice.

Set `fontFamily: "var(--font-body)"` on these two, not `--font-data`. Drop their `letterSpacing` and `textTransform` if present — those belong to the uppercase chrome register, not to a sentence-case heading.

- [ ] **Step 5: Run the guard and the full suite**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/display-face.test.ts
pnpm test
```

Expected: the guard passes with an empty offender list; all 271 existing tests still pass, because none asserts on a font.

- [ ] **Step 6: Revert-check the guard**

Put one illegal size back — `fontSize: "13px"` on `ui.tsx`'s `Button` with `--font-display` restored — and confirm the guard fails naming that file and line. Restore. Report the result: a guard that cannot fail is not a guard.

- [ ] **Step 7: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Subject: `fix(web): stop rendering the pixel face at sizes that destroy it :eyeglasses:`
Body: the measured design size, the fact that only the wordmark was ever right, and that the guard is source-level because no rendering test can see a font size.

---

### Task 4: `ConfirmAction`, and pending that does not steal focus

**Files:**
- Create: `apps/web/src/components/ConfirmAction.tsx`, `apps/web/src/__tests__/confirm-action.test.tsx`
- Modify: `apps/web/src/components/ui.tsx`, `apps/web/src/pages/MachinesPage.tsx`, `apps/web/src/pages/LessonDetail.tsx`

**Interfaces:**
- Consumes: `Button` from `./ui`.
- Produces: `<ConfirmAction trigger question confirmLabel onConfirm pending variant? />` from `../components/ConfirmAction`. Tasks 6 and 7 assume both pages already route through it.

**This task changes behavior deliberately**, which no other task in this plan does. `ui.tsx`'s `Button` currently sets the `disabled` attribute while loading, and its comment says that is intentional. Disabling a focused element moves focus to `<body>` — in the middle of a destructive action, for a keyboard user. Replace the comment; do not delete the reasoning it replaces.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/__tests__/confirm-action.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmAction } from "../components/ConfirmAction";

function setup(props: Partial<React.ComponentProps<typeof ConfirmAction>> = {}) {
	const onConfirm = vi.fn();
	render(
		<ConfirmAction
			trigger="Retract"
			question="Stop trusting this lesson everywhere?"
			confirmLabel="Yes, retract"
			onConfirm={onConfirm}
			variant="danger"
			{...props}
		/>,
	);
	return { onConfirm };
}

describe("ConfirmAction", () => {
	// The bug this exists to prevent: disabling a focused button moves focus to
	// <body>, so a keyboard user loses their place mid-action - in the one flow
	// where the next keystroke matters most.
	it("keeps focus on the confirm button while the action is pending", () => {
		const { rerender } = render(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={vi.fn()}
				pending={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.getByRole("button", { name: "Yes, retract" });
		expect(document.activeElement).toBe(confirm);

		rerender(
			<ConfirmAction
				trigger="Retract"
				question="Sure?"
				confirmLabel="Yes, retract"
				onConfirm={vi.fn()}
				pending={true}
			/>,
		);
		expect(document.activeElement, "focus escaped to the body").toBe(confirm);
		expect(confirm.getAttribute("aria-busy")).toBe("true");
	});

	it("moves focus to the confirm button when armed", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Yes, retract" }),
		);
	});

	it("returns focus to the trigger on cancel", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Retract" }),
		);
	});

	// Without this a screen reader reaching "Yes, retract" hears no question at
	// all - only the answer.
	it("associates the question with the confirm button", () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.getByRole("button", { name: "Yes, retract" });
		const describedBy = confirm.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)?.textContent).toBe(
			"Stop trusting this lesson everywhere?",
		);
	});

	it("does not fire while pending", () => {
		const { onConfirm } = setup({ pending: true });
		fireEvent.click(screen.getByRole("button", { name: "Retract" }));
		const confirm = screen.queryByRole("button", { name: "Yes, retract" });
		if (confirm) fireEvent.click(confirm);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/confirm-action.test.tsx`
Expected: FAIL — `../components/ConfirmAction` does not exist.

- [ ] **Step 3: Change `Button`'s pending treatment**

In `apps/web/src/components/ui.tsx`, replace the `isDisabled` block and its comment:

```tsx
	// Pending is announced, not disabled. Setting the `disabled` attribute here
	// - which this did - moves focus to <body> the instant the button the user
	// just pressed goes inert, and it does it in the middle of a destructive
	// round-trip. aria-busy says the same thing to assistive tech, aria-disabled
	// says it to everyone, and the handler guard below is what actually stops a
	// second press. The reason for the original treatment still holds: retract
	// round-trips rather than updating optimistically, so the control is live
	// for as long as the request takes and a second press would transition a
	// lesson already moving. Only the mechanism changed.
	const inert = loading || disabled;
	const plate = variant === "danger" ? PALETTE.plateRed : PALETTE.plateTeal;
	return (
		<button
			type="button"
			aria-busy={loading ? true : undefined}
			aria-disabled={inert || undefined}
			onClick={() => {
				if (inert) return;
				onClick();
			}}
			style={{
				/* unchanged, but read `inert` where it read `isDisabled` */
			}}
		>
```

Keep every style branch exactly as it was, reading `inert` in place of `isDisabled`. The look does not change; only focus behavior and the attributes do.

- [ ] **Step 4: Write `ConfirmAction`**

Create `apps/web/src/components/ConfirmAction.tsx`:

```tsx
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui";

/**
 * Arm, then confirm. Both destructive acts in the app work this way and both
 * had their own copy of it - retract in LessonDetail, revoke in MachinesPage.
 *
 * Inline rather than window.confirm, because these are the most consequential
 * acts in the product and neither should be handed to a native dialog that
 * looks like nothing else in the app. A retraction reaches every mirror on its
 * next delta pull.
 *
 * The focus handling is the reason this is a component rather than a snippet.
 * Arming replaces the trigger with this row, which destroys the focused element
 * unless something moves focus deliberately; cancelling destroys it again.
 */
export function ConfirmAction({
	trigger,
	question,
	confirmLabel,
	onConfirm,
	pending = false,
	variant = "danger",
	pendingLabel = "Working...",
}: {
	trigger: string;
	question: string;
	confirmLabel: string;
	onConfirm: () => void;
	pending?: boolean;
	variant?: "primary" | "danger";
	pendingLabel?: string;
}) {
	const [armed, setArmed] = useState(false);
	const questionId = useId();
	const triggerRef = useRef<HTMLDivElement>(null);
	const confirmRef = useRef<HTMLDivElement>(null);
	// Distinguishes "armed on this render" from "re-rendered while armed", so
	// focus moves once rather than stealing it back on every keystroke elsewhere.
	const justArmed = useRef(false);
	const justCancelled = useRef(false);

	useEffect(() => {
		if (justArmed.current) {
			justArmed.current = false;
			confirmRef.current?.querySelector("button")?.focus();
		}
		if (justCancelled.current) {
			justCancelled.current = false;
			triggerRef.current?.querySelector("button")?.focus();
		}
	});

	if (!armed) {
		return (
			<div ref={triggerRef} style={{ display: "inline-block" }}>
				<Button
					variant={variant}
					disabled={pending}
					onClick={() => {
						justArmed.current = true;
						setArmed(true);
					}}
				>
					{trigger}
				</Button>
			</div>
		);
	}

	return (
		<div
			ref={confirmRef}
			style={{
				display: "flex",
				gap: "var(--space-2)",
				alignItems: "center",
				flexWrap: "wrap",
			}}
		>
			<span id={questionId}>{question}</span>
			<Button
				variant={variant}
				loading={pending}
				loadingLabel={pendingLabel}
				describedBy={questionId}
				onClick={onConfirm}
			>
				{confirmLabel}
			</Button>
			<Button
				disabled={pending}
				onClick={() => {
					justCancelled.current = true;
					setArmed(false);
				}}
			>
				Cancel
			</Button>
		</div>
	);
}
```

`Button` needs one new optional prop to carry the association. Add to its props and spread it onto the `<button>`:

```tsx
	describedBy,
	// ...
}: {
	// ...
	/** Wired to aria-describedby. ConfirmAction uses it to name the question. */
	describedBy?: string;
}) {
```

```tsx
			aria-describedby={describedBy}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/confirm-action.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Route both pages through it**

Read `MachinesPage.tsx` and `LessonDetail.tsx` first. Replace each page's hand-rolled confirm block with `ConfirmAction`, keeping every existing behavior:

- `MachinesPage`'s `confirming` state becomes per-row: `ConfirmAction` owns `armed` internally, so the page keeps only `revoking` (which id is in flight) and drops `confirming`.
- `LessonDetail` keeps `pending` and `actionError` and drops `confirming`. **Do not touch** the `currentId` ref, the reset effect keyed on `id`, or the `requestSeq`-style guards — those are race fixes with their own tests.
- Both pages' existing tests must still pass unchanged. Accessible names do not change: the trigger is still `Retract`/`Revoke`, the confirm still `Yes, retract` / `Yes, revoke`.

**The `id`-change reset in `LessonDetail` is the subtle one.** It currently sets `confirming` false when the route param changes, which is what stops an armed prompt following the user to another lesson. With `armed` inside `ConfirmAction`, that reset no longer reaches it. Give `ConfirmAction` a `key={id}` at the `LessonDetail` call site so a new lesson gets a fresh, unarmed instance — and keep the existing test that pins this.

- [ ] **Step 7: Run the full gates, then commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green, including `machines-page.test.tsx` and the `lessons-page.test.tsx` retract block unchanged.

Subject: `fix(web): stop a pending button from stealing the keyboard :wheelchair:`
Body: that disabling a focused element moves focus to body mid-action, that the original reason for blocking a second press still holds and only the mechanism changed, and that both confirm flows now share one component.

---

### Task 5: The attribution footer

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx`, `apps/web/src/__tests__/app-shell.test.tsx`

**Interfaces:**
- Consumes: `--space-*` from Task 1.
- Produces: nothing.

**This is a license condition, not a nicety.** The icons are CC BY 4.0 by Crusenho Agus Hennihuno. The brand doc requires credit "wherever the icons ship — website footer and the app's about surface at minimum," and says explicitly that a line in a README does not satisfy it. It lands before the screens that render icons.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/__tests__/app-shell.test.tsx`:

```tsx
// CC BY 4.0 requires credit wherever the icons ship. A footer on the shell puts
// it on every authenticated page for as long as the icons are on screen, which
// is what the condition asks for and what an /about route nobody visits does
// not.
it("credits the icon set and links its license", () => {
	renderShell();
	const footer = screen.getByRole("contentinfo");
	expect(footer.textContent).toContain("Crusenho Agus Hennihuno");
	expect(
		screen.getByRole("link", { name: /CC BY 4\.0/i }).getAttribute("href"),
	).toBe("https://creativecommons.org/licenses/by/4.0/");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/app-shell.test.tsx`
Expected: FAIL — no element with role `contentinfo`.

- [ ] **Step 3: Add the footer**

In `AppShell.tsx`, after the closing `</main>`:

```tsx
			{/*
			  A license condition, not a courtesy. CC BY 4.0 requires credit
			  wherever the icons ship, and the brand doc is explicit that a line
			  in a README nobody renders does not satisfy it. On the shell rather
			  than an /about route so it is present on every page the icons are.
			*/}
			<footer
				style={{
					maxWidth: "1100px",
					margin: "0 auto",
					padding: "var(--space-5) var(--space-5) var(--space-6)",
					color: PALETTE.muted,
					fontSize: "var(--text-body-sm)",
					borderTop: `2px solid ${PALETTE.border}`,
				}}
			>
				Icons by{" "}
				<a
					href="https://crusenho.itch.io"
					style={{ color: PALETTE.accent }}
					target="_blank"
					rel="noreferrer"
				>
					Crusenho Agus Hennihuno
				</a>
				, licensed{" "}
				<a
					href="https://creativecommons.org/licenses/by/4.0/"
					style={{ color: PALETTE.accent }}
					target="_blank"
					rel="noreferrer"
				>
					CC BY 4.0
				</a>
				.
			</footer>
```

- [ ] **Step 4: Run the test, then the full gates, then commit**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/app-shell.test.tsx
pnpm test && pnpm typecheck && pnpm lint
```

Subject: `feat(web): credit the icon set the license requires crediting :scroll:`
Body: that CC BY 4.0 is a condition rather than a courtesy, and that it lands before the first icon renders.

---

### Task 6: `/lessons` — both panes

**Files:**
- Modify: `apps/web/src/pages/LessonsPage.tsx`, `apps/web/src/pages/LessonDetail.tsx`, `apps/web/src/components/ui.tsx`, `apps/web/src/__tests__/lessons-page.test.tsx`

**Interfaces:**
- Consumes: `Icon` and `IconName` (Task 2), the scales (Task 1), `ConfirmAction` (Task 4).
- Produces: nothing.

**Read both pages before editing.** They carry `requestSeq`, `currentId`, a mirror effect and a reset effect, each with a comment explaining a race it fixes. None is yours to change; if a styling edit appears to need one, stop and report it.

- [ ] **Step 1: Give `StatusBadge` its icon**

In `ui.tsx`, map each status to an icon and render it inside the badge:

```tsx
/**
 * Status is readable before a word is read. The plate says whether the claim is
 * in force; the icon says what happened; the word remains for anyone the first
 * two do not reach.
 *
 * `Restart` for superseded - the claim run again rather than thrown away, which
 * is why it is not Trashbin. Recorded in the brand doc with the rest of the
 * mapping.
 */
const STATUS_ICONS: Record<LessonStatus, IconName> = {
	active: "Lightbulb",
	retracted: "Trashbin",
	refuted: "Skull",
	superseded: "Restart",
};
```

Render `<Icon name={STATUS_ICONS[status]} />` before the label, inside a flex row with `gap: var(--space-1)`. The icon is decorative here — the label is right beside it — so pass no `label`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/web/src/__tests__/lessons-page.test.tsx`:

```tsx
describe("the visual language", () => {
	it("gives every row a status icon", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);
		// Two rows in the list, plus the detail pane's placeholder shows none.
		const icons = document.querySelectorAll("img.pixel-icon");
		expect(icons.length).toBeGreaterThanOrEqual(2);
		for (const img of icons) {
			expect(img.getAttribute("src")).toBeTruthy();
		}
	});

	// Every icon in the app is 16, 32 or 48. Anything else is mush.
	it("renders every icon at a legal size", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		await screen.findByRole("heading", { name: VITE.claim });
		for (const img of document.querySelectorAll("img.pixel-icon")) {
			expect(["16", "32", "48"]).toContain(img.getAttribute("width"));
		}
	});

	it("splits the detail's facts into what it applies to and why it was trusted", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		expect(await screen.findByRole("heading", { name: /applies to/i })).toBeDefined();
		expect(screen.getByRole("heading", { name: /why it was trusted/i })).toBeDefined();
	});

	// Retraction reaches every mirror on its next delta pull, so the evidence
	// should be passed on the way to the button rather than after it.
	it("puts the retract control after the evidence in document order", async () => {
		withPool([VITE]);
		await at(`/lessons/${VITE.id}`);
		const trusted = await screen.findByRole("heading", { name: /why it was trusted/i });
		const retract = screen.getByRole("button", { name: /^retract$/i });
		expect(
			trusted.compareDocumentPosition(retract) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx`
Expected: FAIL — no `img.pixel-icon` in the list, no "Applies to" heading.

- [ ] **Step 4: Restructure the detail pane**

Replace the flat stack of eight `Field` blocks with:

1. A header row: `<Icon>` for the status, `StatusBadge`, and the promoted date beside `<Icon name="Trophy" />`.
2. The claim as an `h1` at `var(--text-body-lg)` in the **body** face — it is a sentence and must stay readable; pixel type is measurably harder to read at length. It leads by size and weight, not by face.
3. The rationale as prose.
4. A `2px solid ${PALETTE.border}` rule.
5. Two `Panel`s side by side on wide screens, stacked on narrow, using the existing `lessons.css` breakpoint idiom:
   - **Applies to** (`MagnifyingGlass`): stack, scope, file patterns, task kinds — the four `applies_to` facts, as `Chip`s.
   - **Why it was trusted** (`Trophy`): consensus, what was observed, provenance.
6. `ConfirmAction` last.

Keep `Field` for the labels inside each panel; it becomes a panel-internal label rather than the page's whole structure. Its heading level is `h3`, not `h2`: each `Panel` here carries a title, and that title renders as the `h2` — `Field`'s label then nests correctly beneath it as an `h3`, rather than sitting beside it as a sibling. (A skip is a level jumped over going down, e.g. `h1` straight to `h3` with no `h2` between; `h2` to `h3` is ordinary nesting, not one.)

- [ ] **Step 4b: Give the shell its icons**

`apps/web/src/components/AppShell.tsx`. The spec requires the nav to carry 16px icons and the wordmark to carry `Eye`; without this the two restyled screens sit inside chrome that still looks untouched.

`Eye` at 16 beside the `Onlooker` wordmark — it is both the logo and the active state in the brand mapping. Then one 16px icon per nav link, inside the existing `NavLink`, before the label:

| Link | Icon |
|---|---|
| Lessons | `ChestTreasure` — the approved pool |
| Machines | `Key` |
| Settings | `Gear` |
| Profile | `CatHead` |

All decorative — the visible label is right beside each, so pass no `label` and let `Icon` render `alt=""` with `role="presentation"`.

`CatHead` is an extension, not a brand-doc entry: the set has no person icon, and it is the most person-like thing in it. Write it into the brand doc's mapping alongside `Restart` and `Sleep`, the same way Task 1 recorded those.

**While you are in this file, fix a false comment.** Its header still ends "Nothing routes through it yet." That has been untrue since `/machines` shipped — `App.tsx` wraps both `/lessons` and `/machines` in `AppShell`. Correct it to say what is true now.

Add to `app-shell.test.tsx`:

```tsx
	// The nav is four identical links plus a wordmark; the icons are what make
	// them scannable at a glance rather than a column of same-shaped words.
	it("gives the wordmark and every nav link an icon", () => {
		renderShell();
		const icons = document.querySelectorAll("img.pixel-icon");
		expect(icons.length).toBe(5);
		for (const img of icons) {
			expect(img.getAttribute("width")).toBe("16");
			expect(img.getAttribute("src")).toBeTruthy();
		}
	});
```

- [ ] **Step 5: Restructure the list rows**

Each row becomes a flex row: a 28px plated square holding the 16px status icon, then the claim, then a meta line with the stack `Chip` and the `When` date. Use `var(--space-*)` for every gap and `var(--text-body-*)` for every size. Add `<Icon name="MagnifyingGlass" />` beside the filter label and `<Icon name="ChestTreasure" size={48} />` to the empty-pool `EmptyState`.

- [ ] **Step 6: Announce what changes without a page load**

Three states currently change silently for a screen-reader user: the filter
returning a different set, a "Load more" appending rows, and the detail pane
loading. Add the test first:

```tsx
	// Changing the filter replaces the list with no navigation and no focus
	// change, so without a live region a screen-reader user hears nothing at
	// all - not the new count, not an empty result, not a failure.
	it("announces the pool's state when the filter changes it", async () => {
		withPool([VITE, D1]);
		await at("/lessons");
		await screen.findByText(VITE.claim);

		withPool([]);
		fireEvent.change(screen.getByLabelText(/status/i), {
			target: { value: "retracted" },
		});

		const status = await screen.findByRole("status");
		expect(status.textContent).toMatch(/no retracted lessons/i);
	});
```

Then implement: wrap the list pane's result region in a container carrying
`role="status"` and `aria-live="polite"`, so its text content is announced when
it changes. `polite` rather than `assertive` — a filter result is information,
not an interruption. Give the detail pane's "Loading that lesson..." the same
`role="status"`.

**Do not put the live region on the `<nav>` of rows itself.** Announcing fifty
row labels on every filter change is worse than silence. The region should carry
a short summary — the count, or the empty-state title — and the rows should sit
outside it.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/lessons-page.test.tsx`
Expected: PASS. If a pre-existing assertion fails, **stop and report which one** — the two most likely are the heading-level queries and `getAllByText("Retracted").length === 2`. The latter breaking means the row and detail diverged, which is what it exists to catch.

- [ ] **Step 8: Run the full gates, then commit**

Subject: `feat(web): let the pool look like it belongs to this product :bookmark_tabs:`
Body: why status became an icon, why the detail's facts split into two questions, and why Retract sits after the evidence.

---

### Task 7: `/machines` — rows and the reveal

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx`, `apps/web/src/components/TokenReveal.tsx`, `apps/web/src/__tests__/machines-page.test.tsx`

**Interfaces:**
- Consumes: `Icon` (Task 2), the scales (Task 1), `ConfirmAction` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/machines-page.test.tsx`:

```tsx
// Minting a token and never pointing a plugin at it is the likeliest first-run
// failure in the product. A sleeping key says that faster than a word does -
// and the word stays, because the icon alone would be a puzzle.
it("marks a machine that has never been used with its own icon", async () => {
	withMachines(NEVER_USED);
	await renderPage();
	expect(await screen.findByText(/never used/i)).toBeDefined();
	const icons = [...document.querySelectorAll("img.pixel-icon")];
	expect(icons.some((i) => (i.getAttribute("src") ?? "").includes("Sleep"))).toBe(true);
});

it("renders every icon at a legal size", async () => {
	withMachines(USED, NEVER_USED, REVOKED);
	await renderPage();
	await screen.findByText(USED.name);
	for (const img of document.querySelectorAll("img.pixel-icon")) {
		expect(["16", "32", "48"]).toContain(img.getAttribute("width"));
	}
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx`
Expected: FAIL — no `img.pixel-icon`.

- [ ] **Step 3: Convert the table to rows**

Replace the `<table>` with the same row grammar `/lessons` uses: a plated square holding `Key` (teal for live, red for revoked) or `Sleep` (for never used), the machine name, then a meta line with created and last-used dates via `When`. Keep the `Chip` reading "Revoked" and the words "Never used" — the icons are a second channel, not a replacement, and removing the words would make status readable only to someone who has learned the icon set.

Keep `ConfirmAction` for revoke, as Task 4 wired it.

- [ ] **Step 4: Weight the reveal**

In `TokenReveal.tsx`, add `<Icon name="Key" size={48} />` to the dialog header. **Change nothing else.** The focus trap, the explicit dismissal, the absence of a timeout and the `beforeunload` guard are all deliberate and tested; this is the one moment in the app where a credential is shown once and never again, and only its visual weight is in scope.

- [ ] **Step 5: Run the tests, the full gates, then commit**

```bash
pnpm --filter @onlooker/web exec vitest run src/__tests__/machines-page.test.tsx
pnpm test && pnpm typecheck && pnpm lint
```

Expected: all green, including `token-reveal.test.tsx` unchanged.

Subject: `feat(web): give machines the same grammar as the pool :key:`
Body: why "never used" earned its own icon, and that the reveal gained weight without gaining behavior.

---

## Closing out

```bash
pnpm test && pnpm typecheck && pnpm lint
git status
```

Open the PR with `/pr`. Do not push to `main`.

On merge:

```bash
bd close onlooker-ss1
bd close onlooker-8pt   # absorbed: every item shipped in Tasks 4 and 5
bd ready
```

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §1 scales in `packages/brand`, split by face | 1 |
| §1 display face legal at 16/32/48; small chrome to `--font-data` | 1, 3 |
| §2 icons at 16/32/48 only | 2 |
| §2 `packages/brand/index.ts` icon union | 2 |
| §2 `Icon.tsx` thin wrapper | 2 |
| §2 mapping written back to the brand doc | 1 |
| §3 list rows lead with a plated status icon | 6 |
| §3 detail splits into "applies to" / "why it was trusted" | 6 |
| §3 Retract after the evidence | 6 |
| §4 machines rows, `Sleep` for never-used, reveal at 48 | 7 |
| §5 pending uses `aria-busy`, not `disabled` | 4 |
| §5 `ConfirmAction` owns focus and `aria-describedby` | 4 |
| §5 live regions for filter results and appended rows | 6 |
| §6 attribution footer on `AppShell` | 5 |
| §7 display-face correction is unguarded → add the guard | 3 |

**One gap found and closed:** the first draft had no task for §5's polite live regions. Added as Task 6 Step 6, rather than an eighth task, because a live region with no list to announce is untestable on its own and Task 6's diff already touches every element involved.

**Placeholder scan.** No TBDs. Every code step carries its code. The two judgment calls — the 24px headings in Task 3, and any pre-existing test that fails in Task 6 — are explicitly framed as *report, do not decide*.

**Type consistency.** `IconName` is defined in Task 2 and consumed under that name in 4, 6 and 7. `ICON_NAMES` is the value export, `IconName` the type; both are used as defined. `<Icon name size label>` keeps one signature throughout. `ConfirmAction`'s props are defined once in Task 4 and referenced identically in 6 and 7. `Button` gains exactly one prop, `describedBy`, in Task 4.

**Risk worth naming before starting.** Task 2's glob is the single point of failure for every icon in the app. If `import.meta.glob` resolves nothing, all 80 render as broken images and only the one URL assertion in `icon.test.tsx` would catch it. That test must not be weakened to get the task green.
