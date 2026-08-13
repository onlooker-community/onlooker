# Onlooker Brand — Cozy 16-Bit Direction

**Status:** Approved — not yet implemented
**Date:** 2026-08-11
**Bead:** `onlooker-pbh`
**Visual reference:** <https://claude.ai/code/artifact/47220d2c-c92f-44df-b4c1-852cd4890e95>

---

## Why this exists

`apps/website` owns a brand. `apps/web` ignores it. There is no shared source of
truth, so the two drift by default rather than by decision.

Separately, the product's own vocabulary is already game-flavored — tribunal,
judges, consensus, promotion, lessons, playbooks, the Waypoint hint engine,
visibility tiers. A game aesthetic here is the domain surfacing, not decoration
applied on top of it.

## What this is, and is not

**A skin, not a restructure.** Every layout and flow stays exactly as it is. What
changes is palette, display type, panel and button treatment, and icons carrying
real meaning. A settings page remains a settings page.

Structural work — a lesson pool laid out as an inventory, a tribunal screen, a
promotion quest log — is deliberately out of scope. It fits the domain and may
be worth doing later, but it is a product redesign and this is a rebrand.

## Palette

**Decoded from the assets, not invented.** All 80 icons were decoded and their
pixels counted: 116 distinct colors, and `#464074` appears roughly three times
more often than anything else. It is the set's outline color. Every token below
descends from that, which is why the art sits on these surfaces natively instead
of looking pasted on.

The previous accent `#00d4aa` appears nowhere in the icon palette, and nothing
close to it does. It survives here — but demoted from "the whole identity" to one
specific meaning: **active, observing, alive**.

### Night (default)

| Token | Value | Role |
|---|---|---|
| `--ground` | `#221f38` | page ground — the icons' indigo, darkened |
| `--panel` | `#464074` | raised surface — the icons' own outline color |
| `--edge` | `#6b64a8` | decorative dividers and the grid lattice — see below |
| `--ink` | `#d7d7f2` | body text |
| `--ink-hi` | `#ffffff` | emphasis |
| `--ink-dim` | `#bab5d4` | secondary |
| `--teal` | `#00d4aa` | active / observing |
| `--gold` | `#ffdf40` | reward, the one number that matters |
| `--red` | `#ff9c9c` | refuted, failed |
| `--shadow` | `#141222` | hard offset shadow, no blur |

### Day

Not an inversion — a **daytime tileset**. Day/night palette swaps are a genuine
16-bit convention, so the theme toggle stays inside the fiction rather than
breaking it.

| Token | Value |
|---|---|
| `--ground` | `#d7d7f2` |
| `--panel` | `#b8b8d9` |
| `--edge` | `#6b64a8` |
| `--ink` | `#2a2545` |
| `--ink-hi` | `#141222` |
| `--ink-dim` | `#484366` |
| `--teal` | `#004d3e` |
| `--gold` | `#57390c` |
| `--red` | `#8c1b25` |
| `--shadow` | `#9c95c2` |

### Contrast — verified, on both surfaces

Every accent was checked against **both** the ground and the panel, because text
lands on both and passing on one proves nothing about the other. Several first-pass
values failed and were replaced.

| | on ground | on panel |
|---|---|---|
| night teal `#00d4aa` | 8.32 AAA | 4.90 AA |
| night gold `#ffdf40` | 12.02 AAA | 7.07 AAA |
| night red `#ff9c9c` | 7.94 AAA | 4.67 AA |
| night ink-dim `#bab5d4` | 8.06 AAA | 4.74 AA |
| day teal `#004d3e` | 6.99 AA | 5.11 AA |
| day gold `#57390c` | 7.46 AAA | 5.46 AA |
| day red `#8c1b25` | 6.48 AA | 4.74 AA |
| day ink-dim `#484366` | 6.56 AA | 4.80 AA |

Both `--red` and `--ink-dim` carry body-size text (inline field errors, hints,
captions), so the bar is AA at normal text size — 4.5 — not AA-large. Night
`--red` was `#ff8a8a` at 4.12 on the panel, below that bar; it moved to
`#ff9c9c`. `--ink-dim` was never checked against the panel at all: night was
`#9c95c2` at 3.34, day was `#5a5480` at 3.61. Both moved lighter (night) or
darker (day) until they cleared 4.5 on the panel while staying a step dimmer
than `--ink` — night 4.74 against `--ink`'s 6.63, day 4.80 against 7.52.

**This compresses the visual hierarchy between `--ink` and `--ink-dim`, and
that is forced, not a mistake.** Measured directly against each other rather
than through the panel, night `--ink` vs `--ink-dim` went from 1.99 to 1.40,
and day from 2.08 to 1.57 — roughly a 30% smaller gap. `--panel` is light
enough (night) or dark enough (day) that any color clearing 4.5 against it is
necessarily close to `--ink`, which also has to clear 4.5 against the same
surface. Getting the old separation back would mean moving `--panel` itself,
not `--ink-dim`. If a future pass wants `--ink-dim` to read as dimmer again,
it needs to start there — walking `--ink-dim` back toward its old value
reintroduces the panel failure this task fixed.

**The plate family is unaffected.** `--plate-red` stays `#ff8a8a` — the same
hex night `--red` used to be, before this fix. They are different tokens with
different requirements: a plate is a filled background, constant across
themes, and `--plate-ink` on it is 7.00; `--red` is text ink on a ground or
panel, and shifts per theme. The two happening to share a value at night was
coincidence, not a link between them.

### Borders: `--ink-dim`, not `--edge`

An earlier draft called `--edge` the 2px border token. It cannot be one, and
the reason is arithmetic rather than a poorly chosen value.

A border marking a UI boundary wants 3:1 against what it touches (WCAG 1.4.11).
`--edge` is constant, so one value has to clear that against all four surfaces.
Against the night panel a border needs relative luminance of at least 0.287;
against the day panel, at most 0.132. **No color satisfies both.** A constant
border token that works on both surfaces in both themes does not exist.

Measured, `--edge` `#6b64a8` gives 3.04 night / 3.71 day against `--ground`
and 1.79 / 2.71 against `--panel`. Even the passing side is a 1.3% margin at
night, and it has no fallback: a card is a `--panel` fill on the `--ground`
page, and those two are only 1.70 / 1.37 apart, so if the border does not read
there is no boundary at all.

**So UI boundaries use `--ink-dim`** — 8.06 / 6.56 against the ground, 4.74 /
4.80 against the panel. It shifts per theme, which is exactly what lets it
clear both surfaces.

**`--edge` remains, reclassified as decoration:** hairline dividers and the
website's grid lattice. Those are not boundaries of interactive components, so
1.4.11 does not bind them, and a divider that sits quietly is the intent
rather than a defect. It stays constant across themes; `tokens.test.ts` pins
that, since nothing else would notice the night and day copies drifting apart
and the dividers changing weight with the theme.

There is deliberately no separate 3:1 assertion for the border token.
`--ink-dim` is already held to the stricter 4.5 text floor on both surfaces in
every block, so a 3:1 check on it could not fail without that one failing
first — a test incapable of failing on its own is worse than no test, because
it reads as coverage.

### A plate's own boundary

The contrast table above checks each plate against `--plate-ink`, the text that
sits **on** it. Nothing there says whether the plate is distinguishable **from
what surrounds it**, and those are different questions with different answers.

Plates are constant; surfaces are not. So a plate that separates cleanly at
night can go flat by day, and every plate does:

| plate vs surface | night ground | night panel | day ground | day panel |
|---|---|---|---|---|
| `--plate-teal` | 8.32 | 4.90 | **1.35** | **1.01** |
| `--plate-gold` | 12.02 | 7.07 | **1.07** | **1.46** |
| `--plate-red` | 7.00 | 4.12 | **1.61** | **1.18** |

In day mode a plate is told apart from its surroundings by hue and saturation
alone. That is legible to most sighted readers and invisible to a grayscale,
low-vision or color-blind one.

**So a filled plate needs a second boundary mechanism that works in the theme
where the fill does not.** Two are in use, and both are fine:

- **An outline that shifts, or that contrasts the plate from inside.**
  `apps/web`'s auth buttons and message plates use `2px solid var(--plate-ink)`
  — 8.25 against the day panel from outside, 7.00–8.32 against the plate itself
  at night.
- **An adjacent separator that shifts.** `apps/website`'s one plate element,
  the landing-page form button, has no outline but sits against a
  `1px var(--border-2)` edge. `--border-2` mixes `--edge` with `--ink`, so it
  moves with the theme: 3.28 against the plate by day, exactly where the fill
  is 1.01. At night the fill carries it at 4.90 and the separator does not
  matter.

This cannot be asserted in `tokens.test.ts`. Whether a plate has a working
boundary depends on what it is placed next to, which the package cannot see —
and an assertion that plates clear 3:1 against the surfaces would fail on
every one of them by design. It is a rule for consumers, checked where the
plate is used.

**Rejected during design, recorded so they are not reintroduced:**

- `#db3a3a` as the night red — 2.08 on the panel. Fails outright. It is the same
  red as the Skull icon, which is why it was appealing, and it is unusable for text.
- `#b8791a` as the day gold — 2.57 on ground, 1.88 on panel. Fails both.
- `#00755f` as the day teal — 2.94 on panel.
- `#ff8a8a` as the night red — 4.12 on the panel, below the 4.5 AA floor for
  body-size text. It remains correct as `--plate-red`, a different token.

### Plates are constant; text accents are not

This is the rule the token set turns on, and getting it wrong produced a real
regression during design — worth stating plainly so it is not rediscovered.

An accent used as **text on the ground** and the same accent used as a **plate
background** have opposite requirements. Day gold must be dark to be readable on
a light ground; a gold button must stay bright with dark ink. One token cannot
serve both. Making day gold dark while a button still assumed it was bright
produced dark ink on a dark plate — **1.51**, unreadable — and only in day mode,
which is why it survived the first review.

So the palette has two families:

| Family | Behavior | Tokens |
|---|---|---|
| **Plates** — filled backgrounds | Identical in both themes | `--plate-gold` `#ffdf40`, `--plate-teal` `#00d4aa`, `--plate-red` `#ff8a8a`, `--plate-ink` `#221f38` |
| **Text accents** — ink on a ground | Shift per theme | `--gold` `--teal` `--red` |

A gold button is gold at noon and at midnight. Game UI does not repaint its
buttons when the sun moves, and holding plates constant means their contrast is a
fixed property rather than something to re-verify per theme.

Plates score identically in both: gold 12.02 AAA, teal 8.32 AAA, red 7.00 AAA.

**Plate tokens must be defined once on `:root` and never redefined inside a theme
block.** A theme override on a plate token reintroduces exactly the bug above.

**State pills are filled plates, not colored text on a transparent chip.** A
filled plate is a stronger state signal, and it makes contrast a property of the
plate rather than of wherever the pill happens to sit.

`#db3a3a` survives as `--mark`, for non-text use only — a border, a fill, an icon
tint — where text contrast rules do not apply. It must never carry small text.

## Typography

**Abaddon (CC BY 3.0) for display and chrome only.** Headings, buttons, labels,
stat readouts, nav. Short strings at controlled sizes.

**Body copy stays in a readable face.** Pixel fonts render crisply only at their
design size and integer multiples, and are measurably harder to read at length —
materially so for low-vision and dyslexic readers. The plugin documentation is
real documentation and must not become hostile to read.

Self-host; do not link a CDN. Use `font-display: block` for display type so
headings do not visibly reflow — a pixel face swapping in is far more jarring
than a normal webfont swap.

**Ship the `.ttf` files directly rather than converting to `woff2`.** No
conversion tooling is installed here, and the two faces are 15KB and 23KB — the
saving would be roughly 8KB total, which is noise beside the icon set. Adding a
build dependency to reclaim it is not worth it. Revisit only if the font set grows.

## Icons

80 icons, **every one exactly 16×16**.

- Render at **16, 32, or 48 only**. Never any size between. Non-integer scaling
  destroys pixel art.
- `image-rendering: pixelated` everywhere they appear.
- `flex: none` on the icon element. In a column flex container the main axis is
  vertical, so a wrapping caption silently squashes the icon — this happened in
  the first draft of the visual reference.

Mapping that carries meaning rather than decoration: **Eye** is the logo and the
active state; MagnifyingGlass is search; Lightbulb is a lesson; Locked/Unlocked
is visibility; Team is org scope; Skull is a failure; ChestTreasure is the
approved pool; Trophy is promotion.

### Attribution is a license condition

Icons by **Crusenho Agus Hennihuno** (<https://crusenho.itch.io>), **CC BY 4.0**.
Credit must appear wherever the icons ship — website footer and the app's about
surface at minimum, with a link to the license. This is a legal obligation, not
a courtesy, and it is not satisfied by a line in a README nobody renders.

## Architecture

A new `packages/brand`, consumed by both apps. One source of truth, so drift
becomes structurally impossible rather than something to remember.

```
packages/brand/
  tokens.css      custom properties, night + day
  fonts/          abaddon-{bold,light}.ttf
  icons/          80 png, 16x16, unmodified
  index.ts        icon name union type (deferred to the apps/web plan)
```

Both `apps/website` (Astro) and `apps/web` (React) import it. Sharing CSS custom
properties works identically across both; icon *components* differ per framework
and each app wraps the shared assets in its own thin component.

**The two apps adopt it in separate passes, and they are not equivalent work.**
`apps/website` has a token layer in `src/styles/globals.css` to replace — a
contained swap. `apps/web` has no styling layer at all: 71 inline `style={{…}}`
props across nine pages, no CSS files, no classNames. Pointing those at
`var(--token)` keeps the layout identical and is still "skin only," but it is a
different kind of job and gets its own plan.

This is what actually closes `onlooker-pbh`. Redesigning the website in place and
extracting later is how the current split arose.

## Out of scope

**PlayfulFree sprite sheet.** The 192×176 sheet of button plates and toggles. It
needs slicing and nine-slice scaling for variable-width buttons — more work than
it appears, and CSS plates get most of the effect. Revisit once the token layer
exists.

**Click SFX.** 194 files, and **the pack shipped with no license file at all**.
Blocked until the itch.io page is checked. It would also need a mute control and
persisted preference before it could ship.

**Structural game screens.** See "What this is, and is not."

**Recoloring the icons.** CC BY 4.0 permits adaptation with changes indicated,
so retinting the set to a different palette is legally available. Not needed —
the palette was derived from the icons instead, which is the cheaper direction.
