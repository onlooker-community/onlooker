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
| `--edge` | `#6b64a8` | 2px borders, never hairlines |
| `--ink` | `#d7d7f2` | body text |
| `--ink-hi` | `#ffffff` | emphasis |
| `--ink-dim` | `#9c95c2` | secondary |
| `--teal` | `#00d4aa` | active / observing |
| `--gold` | `#ffdf40` | reward, the one number that matters |
| `--red` | `#ff8a8a` | refuted, failed |
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
| `--ink-dim` | `#5a5480` |
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
| night red `#ff8a8a` | 7.00 AAA | 4.12 AA-large |
| day teal `#004d3e` | 6.99 AA | 5.11 AA |
| day gold `#57390c` | 7.46 AAA | 5.46 AA |
| day red `#8c1b25` | 6.48 AA | 4.74 AA |

**Rejected during design, recorded so they are not reintroduced:**

- `#db3a3a` as the night red — 2.08 on the panel. Fails outright. It is the same
  red as the Skull icon, which is why it was appealing, and it is unusable for text.
- `#b8791a` as the day gold — 2.57 on ground, 1.88 on panel. Fails both.
- `#00755f` as the day teal — 2.94 on panel.

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
