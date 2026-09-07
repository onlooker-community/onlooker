# Icon Contrast and Payload — Design

Bead: `onlooker-1kr`. Applies to `packages/brand` and `apps/web`.

Discovered from `onlooker-ss1`, whose whole-branch review measured the contrast
problem by decoding the PNGs and then deferred it: the 48px empty-pool case was
fixed on the branch by plating it, and "the nav cases were deliberately left
rather than churning the nav."

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-07 and are
decisions rather than proposals. Every number below was measured on this machine
on 2026-09-07 — icon coverage by decoding the PNGs from
`packages/brand/icons/`, payload from the live production bundle at
`https://app.onlooker.dev/assets/index-B4ulx5Fv.js`.

## Boundary *(approved)*

**In scope:** `packages/brand/index.ts` (an exported list),
`packages/brand/assets.test.ts` (the rule),
`apps/web/src/components/Icon.tsx` (the lookup),
`apps/web/vite.config.ts` (the payload), `apps/web/src/components/AppShell.tsx`
(one `SECTIONS` entry), and an amendment to
`docs/superpowers/specs/2026-08-11-brand-16bit-design.md`.

**Out of scope:** the icon art itself — nothing is repainted. `Plate`,
`StatusBadge` and every plated call site are unchanged, because plates are
already safe and this design does not touch what is not broken.

---

## The bead's acceptance criterion is wrong, and that is the finding

`onlooker-1kr` asks that "an icon's dominant color clears 3:1 against whatever
surface it renders on, or sits on a plate."

Measured against `--panel` at night, every icon in the nav fails it:

| Icon | dominant color | share of icon | contrast |
|---|---|---|---|
| ChestTreasure | `rgb(72,49,95)` | 77% | 1.19 |
| Key | `rgb(120,56,58)` | 61% | 1.08 |
| Gear | `rgb(70,64,116)` | 41% | 1.00 |
| Eye | `rgb(45,77,85)` | 54% | 1.03 |
| CatHead | `rgb(110,51,79)` | 46% | 1.00 |
| Book | `rgb(90,59,72)` | 56% | 1.04 |

Taken literally the criterion would require plating the entire nav or
repainting third-party CC BY art, and the bead itself rejects the first.

The reason is in the bead's own text: these outlines are *deliberately*
`#464074`, the panel color, and "bright bodies carry the shape instead." The
dominant color is the outline — the part of the art designed to recede. A rule
measuring it measures the wrong pixels.

---

## Section 1 — The rule is coverage, not dominant color *(approved)*

**At least 25% of an icon's opaque pixels must clear 3:1 against every moving
ground it renders on** — `--panel` and `--ground`, in both themes. Opaque means
alpha ≥ 128.

Icons rendered on a `Plate` are exempt by construction. A plate's fill is one of
two constant colors that do not shift with the theme, so an icon on one sits on
an identical ground at noon and midnight. This is not a carve-out; it is why
plating is the recommended fix for an icon that cannot meet the floor.

**Why 25%.** It comes from the gap in the measurements rather than from a
standard. Every unplated icon in use lands between 38% and 62% on its worst
ground; the single failure sits at 9–13%. Nothing measures in between, so the
threshold has wide margin on both sides and is not a line drawn through the
data.

| Icon | panel night | panel day | ground night | ground day |
|---|---|---|---|---|
| **ChestTreasure** | **9%** | 87% | **13%** | 87% |
| Basket | 42% | 58% | 42% | 58% |
| Key | 39% | 61% | 39% | 61% |
| Book | 44% | 56% | 44% | 56% |
| Gear | 59% | 41% | 59% | 41% |
| CatHead | 54% | 46% | 54% | 46% |
| Eye | 46% | 54% | 46% | 54% |
| Letter | 58% | 42% | 58% | 42% |
| Pencil | 45% | 48% | 52% | 55% |
| Locked | 55% | 45% | 55% | 45% |
| MagnifyingGlass | 62% | 38% | 62% | 38% |

**This is a legibility rule, not a conformance one, and the distinction is
worth stating.** Every `Icon` in production passes `alt=""` and
`role="presentation"` — the only `label` in the tree is in a test — so WCAG
1.4.11 does not apply to any of them. Nothing here is an accessibility
violation. An icon that is 9% legible at night is still bad, and that is the
whole justification.

**MagnifyingGlass is the case that shows the metric working.** The originating
review flagged it for inverting in day and dropping to 3.55. By coverage it is
38% there — its worst ground, and comfortably over the floor. The single-ratio
view called it a near-miss; the coverage view says the shape holds.

---

## Section 2 — Enforcement lives in `packages/brand` *(approved)*

A test in `packages/brand/assets.test.ts`, which already reads PNG bytes and
parses the IHDR by hand.

**It carries its own luminance and ratio helpers rather than reusing
`tokens.test.ts`'s.** Those are local, unexported, and take hex strings; this
needs RGB triples straight from decoded pixels, so the two would not be the same
function even if one were exported. Twelve duplicated lines, matching how
`assets.test.ts` already keeps `pngSize` local rather than reaching across
files.

**No new dependency.** All 80 icons are 8-bit, color type 6 (RGBA),
non-interlaced — verified, not assumed — which is the simplest case to decode:
inflate the IDAT with `node:zlib`, then undo the five scanline filters. About
forty lines.

**Scoped to an exported `UNPLATED_ICONS` list, because a blanket rule is
impossible.** 19 of the 80 icons fail the floor on one ground or another —
`MusicNotes`, `ShoppingCart`, `Sleep` and `SpeakerOn` are at 0% against the
night panel. Applying the rule to all 80 would fail on the first run and prove
nothing. `Sleep` is the instructive case: it is genuinely rendered, by
`machineIcon`, and it is fine, because `MachinesPage.tsx:299` renders it through
`<Plate>`.

**A stated limit.** Nothing forces `UNPLATED_ICONS` to match reality. An icon
rendered unplated but never added to the list goes unchecked, and the test
cannot see that. The list's comment carries the obligation. Deriving it by
grepping JSX for `<Icon>` and `Panel icon=` was considered and rejected: it
would be brittle in a way that fails silently rather than loudly, which is worse
than a list someone can read.

---

## Section 3 — The Lessons nav icon becomes Basket *(approved)*

One entry in `AppShell`'s `SECTIONS`. Basket measures 42/58/42/58 against
ChestTreasure's 9/13/87/87 — inside the healthy band on every ground rather than
failing two of four.

`docs/superpowers/specs/2026-08-11-brand-16bit-design.md:314` says
"ChestTreasure is the approved pool", so that document gets an amendment. The
principle it records: a mapping should not name an icon that cannot be seen on
the ground it renders on.

**Rejected: plating the nav.** It fixes the class permanently and keeps the
mapping, since plates are theme-constant. Rejected because a 16px icon on a
plate is a 32px box, so it visibly restructures the header for all five items —
solving a one-icon problem with a five-icon change, and doing the "churning the
nav" the originating review declined.

**Rejected: documenting an exception.** Defensible on the facts, since the icon
is decorative and the visible LESSONS label carries the meaning. Rejected
because the first rule the system adopts would ship with a carve-out for the
exact case that motivated it, which is how rules stop being believed.

---

## Section 4 — Icons stop being inlined *(approved)*

`apps/web/vite.config.ts` gains a `build.assetsInlineLimit` function returning
`false` for paths under `packages/brand/icons/`, so icons emit as hashed files
rather than data URIs.

**Measured in production, not estimated.** The live bundle at
`app.onlooker.dev` contains 80 PNG data URIs totaling 30,064 bytes — **9.0% of
the 334,544-byte bundle** — with a median of 378 bytes each. Every icon is under
Vite's default 4096-byte `assetsInlineLimit`, so all 80 inline, including the 60+
that never render.

**`Icon`'s API does not change.** The eager `import.meta.glob` keeps working; it
yields short hashed URLs instead of base64. The unrendered icons then cost disk
in `dist` rather than JS payload or network — nobody fetches a file no page
references.

**Rejected: a non-eager glob.** Lazily importing per icon would emit only what
renders, but makes `urlFor` async and every icon pop in after paint. A worse
experience for a smaller build.

**Rejected: explicit imports of only the rendered icons.** The most efficient
output, and it would let the bundler drop the rest entirely. Rejected because
`Icon` takes a dynamic `IconName` and the union is all 80, so this means
hand-maintaining a second list that silently renders nothing when it drifts.

---

## Section 5 — `urlFor` builds its table once *(approved)*

A module-scope `Map` keyed by icon name, built once at import.

`Object.entries(URLS).find(...)` allocates an 80-pair array on every call, and
`urlFor` is called once per rendered icon. A 50-row pool with a leading plate
per row does that 50 times per render pass. The fix is mechanical and has no
design content; it is here because it is in the bead's acceptance criteria and
it touches the same file as Section 4.

---

## Section 6 — Testing *(approved)*

**The rule itself** is the test in Section 2: every icon in `UNPLATED_ICONS`
clears 25% coverage against all four ground-and-theme combinations. It fails
today on ChestTreasure and passes once Section 3 lands, which is what makes it
worth writing rather than a restatement of the status quo.

**The floor is asserted as a named constant**, so the number that separates
9% from 38% is visible in the failure message rather than buried in a
comparison.

**`urlFor`** keeps its existing coverage in `apps/web/src/__tests__/icon.test.tsx`,
which already asserts the glob resolved and that a name maps to a URL. The Map
is an internal change and needs no new test; a test asserting "it uses a Map"
would pin the implementation rather than the behavior.

**The payload change is verified by building, not by a unit test.** `pnpm build`
then counting `data:image/png` occurrences in the emitted chunk — the same
measurement taken against production above, so before and after are directly
comparable.

---

## Consequences

**`onlooker-1kr` closes**, with all three acceptance criteria met — though the
first is met by a corrected metric rather than the one it names, and the bead
gets a note saying why.

**`2026-08-11-brand-16bit-design.md` gains an amendment** for the mapping
change, and the contrast rule becomes the thing that spec was missing: it
governs icon SIZE and says nothing about the surface an icon sits on.
