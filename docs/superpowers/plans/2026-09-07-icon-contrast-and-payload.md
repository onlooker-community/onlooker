# Icon Contrast and Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a measured legibility floor on every icon rendered without a plate, stop shipping 30KB of icons nothing renders, and stop rebuilding an 80-entry lookup table on every icon render.

**Architecture:** `packages/brand` gains an exported `UNPLATED_ICONS` list and a test that decodes each one's PNG with `node:zlib` and asserts at least 25% of its opaque pixels clear 3:1 against `--panel` and `--ground` in both themes. The Lessons nav icon changes to one that passes. `apps/web`'s Vite config stops inlining icon PNGs, and `Icon.tsx` builds its name→URL map once.

**Tech Stack:** TypeScript, Vitest 4, Node 20 (`node:zlib`, `node:fs`), Vite 8, React 18.

**Spec:** `docs/superpowers/specs/2026-09-07-icon-contrast-and-payload-design.md`

**Bead:** `onlooker-1kr`. **Branch:** `feat/icon-contrast-rule-and-lighter-payload`.

## Global Constraints

- **Edit tracked files with `Edit`/`Write`, never with `sed`/heredocs.** The `lineage` and `inspector` plugins hook `PostToolUse` on the file tools only; a shell edit moves the same bytes invisibly and `/lineage` then answers "no record" for a line that was demonstrably written. See the repo `CLAUDE.md`.
- **The floor is 25% of opaque pixels (alpha ≥ 128) clearing 3:1**, against all four of `--panel` night `#464074`, `--panel` day `#b8b8d9`, `--ground` night `#221f38`, `--ground` day `#d7d7f2`.
- **No new dependencies.** The decoder is `node:zlib` plus arithmetic. Adding an image library for this is out of scope.
- **Do not repaint any icon.** The art is third-party CC BY and out of scope.
- **American English** in all comments and commit messages.
- **Commits go through the `/commit` skill**, every time.
- **Do not push or open a PR** until Task 3 completes.
- Tests: from `packages/brand`, `pnpm test`. From `apps/web`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/brand/index.ts` | Icon names and types | Add `UNPLATED_ICONS` |
| `packages/brand/assets.test.ts` | Asset invariants | Add the decoder and the coverage rule |
| `apps/web/src/components/AppShell.tsx` | Shell chrome | One `SECTIONS` entry |
| `docs/superpowers/specs/2026-08-11-brand-16bit-design.md` | The brand doc | Amend the icon mapping |
| `apps/web/vite.config.ts` | Build config | Stop inlining icon PNGs |
| `apps/web/src/components/Icon.tsx` | The icon component | Module-scope `Map` |

Task 1 is one task rather than two: the test is written against the *current* nav, fails on ChestTreasure, and the swap is what makes it pass. Splitting them would land a knowingly-red suite.

---

## Task 1: The contrast rule, and the icon that fails it

**Files:**
- Modify: `packages/brand/index.ts:95` (add after `IconName`)
- Modify: `packages/brand/assets.test.ts:1-2` (top imports) and `:74` (the mid-file `./index` import), then append the new describe
- Modify: `apps/web/src/components/AppShell.tsx:23-24` (the `SECTIONS` entry)
- Modify: `docs/superpowers/specs/2026-08-11-brand-16bit-design.md` (amendment)

**Interfaces:**
- Produces: `UNPLATED_ICONS`, a named export of `packages/brand/index.ts`, typed `readonly IconName[]` via `as const satisfies readonly IconName[]`. Only `assets.test.ts` consumes it. Tasks 2 and 3 do not.

- [ ] **Step 1: Add the `UNPLATED_ICONS` list**

Append to `packages/brand/index.ts`, after the `IconName` export at `:95`:

```ts
/**
 * Every icon the app renders directly rather than through a `Plate`.
 *
 * A plate's fill is one of two constant colors that do not shift with the
 * theme, so an icon on one sits on an identical ground at noon and midnight.
 * Everything here lands on `--panel` or `--ground`, both of which move, and
 * has to stay legible on all four combinations - which `assets.test.ts`
 * asserts.
 *
 * THIS LIST IS THE ENFORCEMENT SURFACE. Nothing derives it from the app, so an
 * icon rendered unplated and not added here simply goes unchecked. The rule
 * cannot just apply to all 80: 19 of them cannot meet the floor, and
 * MusicNotes, ShoppingCart, Sleep and SpeakerOn measure 0% against the night
 * panel. Sleep is the instructive one - it really is rendered, by
 * `machineIcon`, and it is fine, because MachinesPage renders it in a `Plate`.
 */
export const UNPLATED_ICONS = [
	// AppShell's nav and wordmark.
	"ChestTreasure",
	"Key",
	"Book",
	"Gear",
	"CatHead",
	"Eye",
	// Panel titles, through `Panel`'s own h2.
	"Letter",
	"Locked",
	"Pencil",
	"Trashbin",
	"Trophy",
	"MagnifyingGlass",
	// LessonDetail's status header, which renders STATUS_ICONS unplated.
	"Lightbulb",
	"Skull",
	"Restart",
] as const satisfies readonly IconName[];
```

`ChestTreasure` is listed deliberately — it is what the nav renders today, and Step 3 is where the test proves it should not.

- [ ] **Step 2: Write the rule**

In `packages/brand/assets.test.ts`, add `inflateSync` to the top import block, which is currently lines `:1-2`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
```

**`ICON_NAMES` is not imported there.** This file has a second, mid-file import at `:74`, sitting between two `describe` blocks. Extend that one rather than adding a third import statement:

```ts
import { ICON_NAMES, UNPLATED_ICONS } from "./index";
```

Then append at the end of the file:

```ts
/**
 * Decode a 16x16 8-bit RGBA non-interlaced PNG into raw RGBA bytes.
 *
 * Deliberately narrow. The test above asserts every icon is exactly 16x16, and
 * all 80 are color type 6 with no interlacing - checked 2026-09-07 - so
 * palette images, 16-bit channels and Adam7 are unreachable here. Handling
 * them would be dead code carrying its own bugs, so this throws instead.
 */
function decodeRgba(path: URL): Buffer {
	const buf = readFileSync(path);
	const [depth, colorType, interlace] = [buf[24], buf[25], buf[28]];
	if (depth !== 8 || colorType !== 6 || interlace !== 0) {
		throw new Error(
			`${path.pathname}: expected 8-bit RGBA non-interlaced, got depth=${depth} colorType=${colorType} interlace=${interlace}`,
		);
	}

	const idat: Buffer[] = [];
	let off = 8;
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("ascii", off + 4, off + 8);
		if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
		if (type === "IEND") break;
		off += 12 + len;
	}

	// Each scanline is one filter byte followed by the row, and every filter
	// but None refers back to already-reconstructed bytes - so this has to
	// walk in order and read from `out`, not from `raw`.
	const raw = inflateSync(Buffer.concat(idat));
	const stride = 16 * 4;
	const out = Buffer.alloc(16 * stride);
	for (let y = 0; y < 16; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(
			y * (stride + 1) + 1,
			y * (stride + 1) + 1 + stride,
		);
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? out[y * stride + x - 4] : 0;
			const up = y > 0 ? out[(y - 1) * stride + x] : 0;
			const upLeft = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
			let v = line[x];
			if (filter === 1) v += left;
			else if (filter === 2) v += up;
			else if (filter === 3) v += Math.floor((left + up) / 2);
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pl = Math.abs(p - left);
				const pu = Math.abs(p - up);
				const pul = Math.abs(p - upLeft);
				v += pl <= pu && pl <= pul ? left : pu <= pul ? up : upLeft;
			}
			out[y * stride + x] = v & 255;
		}
	}
	return out;
}

// Its own copy rather than tokens.test.ts's: those are local, unexported, and
// take hex strings, and this needs RGB straight from decoded pixels.
function channel(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(r: number, g: number, b: number): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function hexLuminance(hex: string): number {
	return luminance(
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	);
}
function ratio(a: number, b: number): number {
	const [hi, lo] = a > b ? [a, b] : [b, a];
	return (hi + 0.05) / (lo + 0.05);
}

/** The share of an icon's opaque pixels that clear 3:1 against one ground. */
function coverage(path: URL, groundHex: string): number {
	const px = decodeRgba(path);
	const ground = hexLuminance(groundHex);
	let opaque = 0;
	let clearing = 0;
	for (let i = 0; i < px.length; i += 4) {
		// Half-transparent pixels are antialiasing, not the shape.
		if (px[i + 3] < 128) continue;
		opaque++;
		if (ratio(luminance(px[i], px[i + 1], px[i + 2]), ground) >= 3) clearing++;
	}
	return opaque === 0 ? 0 : clearing / opaque;
}

/**
 * The floor, and it comes from the gap in the data rather than a standard.
 *
 * Measured 2026-09-07: every unplated icon in use lands between 38% and 62% on
 * its worst ground, and the one failure sits at 9-13%. Nothing measures in
 * between, so this has wide margin on both sides.
 *
 * Coverage, and not the "dominant color clears 3:1" that onlooker-1kr asked
 * for. Measured against the night panel, every nav icon fails that at 1.00 to
 * 1.19, because these outlines are deliberately #464074 - the panel color -
 * and the bright bodies carry the shape. Dominant color measures the part of
 * the art designed to recede.
 */
const COVERAGE_FLOOR = 0.25;

/** `--panel` and `--ground` in both themes, from tokens.css. */
const MOVING_GROUNDS: Record<string, string> = {
	"panel at night": "#464074",
	"panel in day": "#b8b8d9",
	"ground at night": "#221f38",
	"ground in day": "#d7d7f2",
};

describe("icons rendered without a plate", () => {
	// This is a legibility rule, not a conformance one. Every Icon in the app
	// is alt="" and role="presentation", so WCAG 1.4.11 does not apply to any
	// of them. An icon 9% legible at night is still bad, which is the whole
	// case for the rule.
	it.each(UNPLATED_ICONS)("%s stays legible on every moving ground", (name) => {
		for (const [where, hex] of Object.entries(MOVING_GROUNDS)) {
			const share = coverage(new URL(`${name}.png`, iconDir), hex);
			// Asserted as a labeled object so a failure names the icon, the
			// ground and the measurement rather than printing two bare numbers.
			expect({
				icon: name,
				on: where,
				clearing: `${Math.round(share * 100)}%`,
				meetsFloor: share >= COVERAGE_FLOOR,
			}).toMatchObject({ meetsFloor: true });
		}
	});
});
```

`iconDir` already exists at the top of the file — do not redeclare it.

- [ ] **Step 3: Run the rule and watch it catch the bug**

From `packages/brand`:

```bash
pnpm test
```

Expected: FAIL, exactly one case — `ChestTreasure stays legible on every moving ground` — reporting `clearing: "9%"` on `panel at night` and `meetsFloor: false`. Every other icon in the list passes.

This failure is the point of the task. If everything passes, the list or the floor is wrong and the rule is worthless; stop and diagnose rather than moving on.

- [ ] **Step 4: Swap the Lessons nav icon**

In `apps/web/src/components/AppShell.tsx`, replace the comment and entry at `:23-24`:

```tsx
	// Basket, not ChestTreasure: the brand doc's mapping named ChestTreasure
	// for the approved pool, but it measures 9% legible against the night
	// panel where this renders. See onlooker-1kr, and the amendment on the
	// 2026-08-11 brand spec.
	{ to: "/lessons", label: "Lessons", icon: "Basket" },
```

- [ ] **Step 5: Move `ChestTreasure` off the unplated list**

In `packages/brand/index.ts`, in `UNPLATED_ICONS`, replace `"ChestTreasure",` with `"Basket",` — keeping it under the same "AppShell's nav and wordmark" comment.

`ChestTreasure` is still rendered, at `LessonsPage.tsx:362`, but with `tone="teal"` so it goes through `Plate`. That is the plate exemption working, not an oversight.

- [ ] **Step 6: Run both suites**

```bash
cd packages/brand && pnpm test
cd ../../apps/web && pnpm test
```

Expected: `packages/brand` all green, including `Basket stays legible on every moving ground`. `apps/web` all green — no test asserts on the nav's icon name, so the swap should be invisible there. If an `apps/web` test fails on an icon count or name, read it before changing it: `app-shell.test.tsx` asserts six `img.pixel-icon` elements, and swapping one icon for another does not change that count.

- [ ] **Step 7: Amend the brand doc**

In `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`, append at the end of the file:

```markdown
---

## Amendment, 2026-09-07 — the mapping needs a ground, not just a meaning

Line 314 above says "ChestTreasure is the approved pool". The nav no longer
uses it; `Basket` does.

ChestTreasure is not wrong as a metaphor. It is wrong on the surface it had to
render on: measured on 2026-09-07, 9% of its opaque pixels clear 3:1 against
`--panel` at night and 13% against `--ground`, where every other unplated icon
in use lands between 38% and 62%. The bright body that carries its shape is
close in luminance to the night panel, so the icon goes soft exactly when the
theme is darkest. `Basket` measures 42% and 58% on the same grounds.

**The principle, which this document lacked.** It governs icon SIZE and says
nothing about the surface an icon sits on. A mapping should not name an icon
that cannot be seen on the ground it renders on, and "which icon means what" is
not separable from "where does it render". `packages/brand`'s `UNPLATED_ICONS`
and the coverage rule in `assets.test.ts` enforce the half of that a document
cannot.

ChestTreasure still renders, on the empty-pool state at
`LessonsPage.tsx:362`, where it sits on a teal `Plate`. Plate fills are
constant across themes, so an icon on one is exempt by construction — which is
why plating is the other way to satisfy the rule.

Full reasoning: `2026-09-07-icon-contrast-and-payload-design.md`.
```

- [ ] **Step 8: Lint and typecheck both packages**

```bash
cd packages/brand && pnpm lint && pnpm typecheck
cd ../../apps/web && pnpm lint && pnpm typecheck
```

Expected: clean. `apps/web` reports 9 pre-existing `noExplicitAny` warnings in `src/api/mockApi.test.ts`; those are not yours.

- [ ] **Step 9: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add packages/brand/index.ts packages/brand/assets.test.ts \
        apps/web/src/components/AppShell.tsx \
        docs/superpowers/specs/2026-08-11-brand-16bit-design.md
```

Message shape — `feat(brand): ...`, body explaining that the bead's dominant-color criterion fails all six nav icons because the outline is the panel color, and that coverage measures the bright body instead. `Refs onlooker-1kr`.

---

## Task 2: Icons stop being inlined

**Files:**
- Modify: `apps/web/vite.config.ts:6-23` (the `build` block)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no code interface. `Icon.tsx` is untouched; the glob keeps returning strings, they are just hashed URLs instead of `data:` URIs.

- [ ] **Step 1: Measure the current bundle**

From `apps/web`:

```bash
pnpm exec vite build >/dev/null 2>&1 && node -e '
const fs=require("fs");
const f=fs.readdirSync("dist/assets").filter(n=>n.endsWith(".js"));
let uris=0,bytes=0,total=0;
for(const n of f){const s=fs.readFileSync("dist/assets/"+n,"utf8");total+=s.length;
  const m=s.match(/data:image\/png;base64,[A-Za-z0-9+\/=]+/g)||[];
  uris+=m.length;bytes+=m.reduce((a,b)=>a+b.length,0);}
console.log("js bytes:",total," png data URIs:",uris," their bytes:",bytes);
'
```

Expected, matching what production serves today: 80 data URIs totaling about 30,064 bytes. Write the exact numbers down — Step 4 compares against them.

`vite build` directly rather than `pnpm build`, which also runs `tsc --noEmit` and a `verify-api-target` script; neither is what this step is measuring.

- [ ] **Step 2: Stop inlining icon PNGs**

In `apps/web/vite.config.ts`, inside the existing `build` block (which currently holds only the long `sourcemap` comment and `sourcemap: true`), add:

```ts
		// Every icon is a few hundred bytes, so all 80 fall under Vite's
		// default 4096-byte inline limit and land in the JS chunk as base64 -
		// 30,064 bytes, 9.0% of what production shipped on 2026-09-07, most of
		// it for icons no page renders.
		//
		// Returning false emits them as hashed files instead. The eager glob in
		// Icon.tsx keeps working unchanged; it yields short URLs rather than
		// data URIs, and the unrendered icons then cost disk in dist rather
		// than payload, because nobody fetches a file no page references.
		//
		// A function rather than a smaller number, so this applies to the icons
		// and leaves every other asset on Vite's default.
		assetsInlineLimit: (filePath: string) =>
			filePath.includes("packages/brand/icons/") ? false : undefined,
```

Returning `undefined` for everything else is deliberate — it means "no opinion", so Vite falls back to its own size test rather than this function deciding for assets it knows nothing about.

- [ ] **Step 3: Rebuild**

```bash
pnpm exec vite build 2>&1 | tail -20
```

Expected: a successful build. The output should now list `dist/assets/*.png` entries it did not before.

If the build errors on the function signature, check the installed Vite version accepts a function for `assetsInlineLimit` (`pnpm exec vite --version`); it has since Vite 5, and this repo is on 8.x.

- [ ] **Step 4: Measure again and confirm the drop**

```bash
node -e '
const fs=require("fs");
const f=fs.readdirSync("dist/assets").filter(n=>n.endsWith(".js"));
let uris=0,bytes=0,total=0;
for(const n of f){const s=fs.readFileSync("dist/assets/"+n,"utf8");total+=s.length;
  const m=s.match(/data:image\/png;base64,[A-Za-z0-9+\/=]+/g)||[];
  uris+=m.length;bytes+=m.reduce((a,b)=>a+b.length,0);}
const png=fs.readdirSync("dist/assets").filter(n=>n.endsWith(".png"));
console.log("js bytes:",total," png data URIs:",uris," their bytes:",bytes," emitted .png files:",png.length);
'
```

Expected: `png data URIs: 0`, `their bytes: 0`, `emitted .png files: 80`, and `js bytes` down by roughly 30,000 from Step 1.

- [ ] **Step 5: Confirm icons still resolve**

```bash
pnpm test
```

Expected: all green, including `icon.test.tsx`'s "resolves a real URL for a known icon". That test exists precisely for this: if the glob ever stopped resolving, every icon would render as a broken image and nothing else would say so.

Note this passes under Vitest, which does not apply `build.assetsInlineLimit` — so it confirms the glob still resolves, not that the build emitted files. Step 4 is what confirms the build.

- [ ] **Step 6: Lint and typecheck**

```bash
pnpm lint && pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/vite.config.ts
```

Message shape — `perf(web): ...`, body carrying the measured before and after. `Refs onlooker-1kr`.

---

## Task 3: `urlFor` builds its table once

**Files:**
- Modify: `apps/web/src/components/Icon.tsx:25-30` (`urlFor`; the `URLS` glob at `:20-23` is unchanged)

**Interfaces:**
- Consumes: nothing from Tasks 1 or 2.
- Produces: no external change. `urlFor(name: IconName): string` keeps its signature; only its body and one module-scope constant change.

- [ ] **Step 1: Replace the per-call scan with a module-scope Map**

In `apps/web/src/components/Icon.tsx`, replace the `urlFor` function (currently `Object.entries(URLS).find(...)`) with:

```tsx
// Built once at import rather than per call. `Object.entries` allocates an
// 80-pair array every time, and urlFor runs once per rendered icon - a 50-row
// pool with a leading plate per row did that 50 times per render pass.
const BY_NAME = new Map<string, string>(
	Object.entries(URLS).map(([path, url]) => [
		path.slice(path.lastIndexOf("/") + 1, -".png".length),
		url,
	]),
);

function urlFor(name: IconName): string {
	return BY_NAME.get(name) ?? "";
}
```

The `?? ""` is kept from the original on purpose: an unknown name renders an empty `src` rather than throwing, and `icon.test.tsx` asserts a known name is non-empty.

- [ ] **Step 2: Run the icon tests**

```bash
pnpm vitest run src/__tests__/icon.test.tsx
```

Expected: PASS, all four. "resolves a real URL for a known icon" is the one that matters — it proves the key derivation matches what the glob produces. If it fails with an empty `src`, the slice is wrong: the glob's keys are full relative paths ending `/Eye.png`, and the key must be exactly `Eye`.

- [ ] **Step 3: Full suite, lint, typecheck**

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Expected: all green.

- [ ] **Step 4: Commit**

Use the `/commit` skill. Stage exactly:

```bash
git add apps/web/src/components/Icon.tsx
```

Message shape — `perf(web): ...`, one line on the per-render allocation. `Refs onlooker-1kr`.

- [ ] **Step 5: Close the bead and open the PR**

```bash
bd update onlooker-1kr --append-notes "<what was measured and what changed>"
bd close onlooker-1kr
```

**Use `--append-notes`, never `--notes`** — `--notes` replaces the whole NOTES body and only warns after the write has already happened.

The note must record that the bead's first acceptance criterion was **not** met as written and why: measured, "dominant color clears 3:1" fails all six nav icons at 1.00-1.19, because the outline is deliberately the panel color. Coverage replaced it.

Then use the `/pr` skill. The PR body should carry the same correction, the before/after payload numbers from Task 2, and the stated limit that `UNPLATED_ICONS` is not derived from the app.

---

## Self-Review

**Spec coverage.** Section 1 (coverage rule, floor, why 25%) → Task 1 Steps 2-3. Section 2 (enforcement in `packages/brand`, own helpers, `UNPLATED_ICONS`, the stated limit) → Task 1 Steps 1-2, with the limit written into the list's own comment. Section 3 (Basket, brand doc amendment) → Task 1 Steps 4-5 and 7. Section 4 (payload) → Task 2. Section 5 (`urlFor`) → Task 3. Section 6 (testing) → Task 1 Step 3 for the rule, Task 2 Steps 1 and 4 for the build measurement, Task 3 Step 2 for `urlFor`'s existing coverage. Consequences → Task 3 Step 5.

**Placeholders.** None. Task 3 Step 5's `--append-notes` argument is deliberately left to the implementer because it records an observation from the run, and the step says exactly what the note must contain.

**Type consistency.** `UNPLATED_ICONS` is spelled identically in Task 1 Steps 1, 2 and 5 and in the File Structure table. `COVERAGE_FLOOR`, `MOVING_GROUNDS`, `coverage()`, `decodeRgba()`, `luminance()`, `hexLuminance()`, `ratio()` and `channel()` are all introduced and consumed within Task 1 Step 2. `BY_NAME` and `urlFor` are confined to Task 3 Step 1. `iconDir` is pre-existing in `assets.test.ts` and flagged as not-to-be-redeclared.
