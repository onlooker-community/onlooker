# App Visual Language — Design

Bead: `onlooker-ss1`. Absorbs `onlooker-8pt`. Applies to `apps/web` and
`packages/brand`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-28 and are
decisions, not proposals. Open questions are collected at the end and are the
only things still genuinely undecided.

## Boundary

**In scope:** `packages/brand` (scales, icon-name type, two corrections to the
2026-08-11 brand design), the shared layer in `apps/web` (`AppShell`, `ui.tsx`, a
new `Icon`, a new `ConfirmAction`), and the two authenticated screens —
`/lessons` (both panes) and `/machines`.

**Also in scope, but for the display-face correction only:** every remaining file
that sets `--font-display` at an illegal size — `form.tsx`, `ErrorBoundary.tsx`,
`SessionExpiryBanner.tsx`, `SettingsPage.tsx`, `ResetPasswordPage.tsx`. These get
their type corrected and nothing else. No layout change, no icons, no
restructuring. A blurred pixel face is a defect wherever it appears, and shipping
two corrected screens beside seven uncorrected ones would make the app look
*more* inconsistent than leaving it alone.

**Out of scope:** `apps/website`. The full visual treatment of the auth pages,
`SettingsPage` and `ProfilePage` — they get the font fix and keep their current
design. The 16-bit direction itself, which was re-confirmed rather than reopened.

The auth pages are the actual first impression and `LoginPage` is hand-rolled
without even using `TextField`, so leaving their layout untouched is a real cost,
accepted deliberately: the language has to exist before it can be applied, and it
is cheaper to prove it on two screens than on nine.

---

## Section 0 — What is already true *(context, not decisions)*

`packages/brand` is a finished, documented design system that `apps/web` is
barely wearing. Measured on 2026-08-28:

- **Zero icons are used anywhere in `apps/web/src`.** All 80 are unreferenced.
- `--gold` appears 3 times, `--plate-gold` once, `--font-data` once. The warm and
  characterful end of the palette is effectively absent.
- The heavily used tokens are `--ink-dim` (18), `--red` (13), `--plate-ink` (10),
  `--panel` (10) — the *functional* subset. Status, danger, muted, borders.
- **No spacing scale and no type scale exist.** Every size in the app is a
  literal inside an inline `style` prop.

That gap is the whole diagnosis. The app is wearing the brand's utility layer and
none of its character, which is why two screens built to a careful data spec still
read as a wireframe.

The 2026-08-11 brand design already anticipated this work. It specifies that
`packages/brand/index.ts` — an icon name union type — is "deferred to the apps/web
plan," and that "icon *components* differ per framework and each app wraps the
shared assets in its own thin component." This document is that plan.

---

## Section 1 — The scales *(approved)*

**Both scales live in `packages/brand/tokens.css`, beside the plates and
accents.** One source of truth. That centralization is not theoretical: it is what
made the plate-versus-accent rule enforceable, and that rule caught a 1.35-contrast
bug. A spacing step is the same kind of fact.

**Spacing, on a 4px base:** `--space-1: 4px` through `--space-7: 48px`
(4 / 8 / 12 / 16 / 24 / 32 / 48). The integer discipline is not arbitrary — the
icons demand exact multiples of 16, and a spacing scale that shares that base
lets an icon sit on a grid line instead of near one.

**Type is split by face,** because the two faces have different constraints.
`--text-body-*` is the readable face and may take ordinary steps.

**Abaddon's design size is 16px, measured from the font itself.** `unitsPerEm`
is 1024 and the greatest common divisor of every glyph coordinate across 95
sampled glyphs is 64 — so one pixel is 64 units, one em is 16 pixels. The brand
doc requires pixel faces to render "at their design size and integer multiples,"
which makes the display face legal at **16, 32 and 48 only**.

That is the same grid the icons sit on, which is a happy result rather than a
coincidence: one rule now governs both, and a 16px icon beside 16px display type
shares a baseline exactly.

**It also means the app is currently violating the rule almost everywhere.**
Audited on 2026-08-28, `--font-display` is used at 24, 16, 14, 13, 12 and 11px.
Only 16px is legal. Every other size renders the pixel face at a fractional
multiple — 24px is 1.5×, 12px is 0.75× — which is the exact failure the icon
size rule exists to prevent, in the other medium. This is measurable, it is
everywhere, and it is part of why two carefully built screens read as unfinished.

So `--text-display-*` has exactly three steps, and **every small chrome label
currently set in the display face moves to `--font-data`** — the monospace token
already in the brand and used exactly once today. Uppercase monospace at 11–12px
keeps the technical register those labels want without mushing a pixel face to
get it.

**Rejected: keeping small display type and accepting the blur.** It is the
status quo, and the status quo is the complaint.

**Rejected: one unified type scale.** It would let a display size land on a
fractional multiple of Abaddon's design size, which is what the audit above
found already happening.

**Rejected: app-local scales.** Faster to iterate, but it means a second source
of truth for what one spacing unit is, and the next app starts from nothing.

**Rejected: brand primitives with app-level semantic aliases**
(`--space-row-gap: var(--space-2)`). Standard design-system layering and more
machinery than two screens need. Revisit if a third consumer appears.

---

## Section 2 — Icons *(approved)*

**Render at 16, 32 or 48 only.** Never between. Non-integer scaling destroys
pixel art. `packages/brand/assets.css` already ships `.pixel-icon` plus the three
size classes, including a `flex: none` that must not be removed — in a column
flex container a wrapping caption silently squashes the icon, which happened once
already.

This constrains layout rather than decorating it. Nav icons cannot be 11px to fit
a tight bar; the bar gets taller. Mockups drawn at 11–14px during design were
invalid and were corrected.

**`packages/brand/index.ts`** exports a union of the 80 icon names, so
`<Icon name="Lightbolb" />` fails at compile time rather than 404ing at runtime.

**`apps/web/src/components/Icon.tsx`** is a thin wrapper over `.pixel-icon` and
the size classes, importing from `@onlooker/brand/icons/*`. Per the brand doc,
each app wraps the shared assets in its own component; this is `apps/web`'s.

**The mapping is the brand doc's, not invented here:**

| Icon | Meaning | Used for |
|---|---|---|
| `Eye` | the logo, and the active state | wordmark |
| `Lightbulb` | a lesson | active status |
| `ChestTreasure` | the approved pool | Lessons nav, empty pool |
| `Trophy` | promotion | `promoted_at`, the "why trusted" panel |
| `Skull` | a failure | refuted status |
| `MagnifyingGlass` | search | the status filter, the "applies to" panel |
| `Key` | — | machine tokens |
| `Trashbin` | — | retracted status |
| `Restart` | — | superseded status |
| `Sleep` | — | a machine that has never been used |
| `Gear` | — | Settings nav |

The last five are extensions consistent with the doc's spirit rather than
entries from it. `Restart` covers `superseded`, which the brand doc's mapping
omitted — a lesson replaced by a newer one is the claim being run again, not
thrown away, which is why it is not `Trashbin`.

**These extensions are written back into `docs/superpowers/specs/2026-08-11-brand-16bit-design.md`.**
An icon mapping that lives only in the consuming app is the drift the brand
package was created to make structurally impossible. The same edit records the
measured design size from Section 1, since the brand doc currently says "their
design size" without naming it — which is precisely why the app could violate the
rule in nine files without anyone noticing.

`Sleep` for "never used" is a deliberate upgrade on the current text chip.
Minting a token and never pointing a plugin at it is the likeliest first-run
failure in the product, and a sleeping key says that faster than a word does.

**An icon's ground matters as much as its size.** The rules above govern
size; they say nothing about the surface an icon sits on, which is how a
48px illustration reached production at 1.42 contrast against `--ground` in
the default theme - measurably legible in day mode, a dark smudge in night.
The rule: an icon's dominant color must clear 3:1 against whatever it
renders on. If it does not, put it on a `Plate` rather than choosing a
different icon - a plate's fill is one of exactly two colors and neither
shifts with the theme, which is what makes it a safe ground regardless of
which theme is active.

---

## Section 3 — `/lessons` *(approved)*

### The list pane: character in the rows

Each row leads with a 16px icon on a plated square — teal for in-force, red for
not. Status becomes readable before a word is read.

**Rejected: icons only in the chrome.** The most scannable at fifty rows and the
least distinctive. It leaves the rows exactly as flat as they are now, which is
the complaint.

**Rejected: full 16-bit** — gold frame, plated section header, a consensus
readout on every row, drop shadow on the panel. Unmistakably Onlooker and the
most decoration competing with the claim the reader came for.

Nav carries 16px icons and the wordmark carries `Eye`. `MagnifyingGlass` sits
beside the status filter. The empty pool gets `ChestTreasure` at 48.

### The detail pane: judgment above the rule, facts below

Today this renders eight identical `Field` blocks — rationale, stack, scope,
files, tasks, consensus, what-was-observed, provenance — every one at the same
weight. That flatness is why nothing directs the eye.

Instead: status icon and badge, the claim at the largest body step, then
rationale. The claim is a sentence and stays in the readable face — the brand doc
is explicit that pixel type is measurably harder to read at length, and the claim
is the one thing on this page that must be read carefully. It leads by size and
weight, not by face. A
rule. Then two labelled panels answering two genuinely different questions —
**Applies to** (`MagnifyingGlass`: stack, scope, files, tasks) and **Why it was
trusted** (`Trophy`: consensus, what was observed, provenance). Those six blocks
are currently shuffled together with no signal that they answer different
things.

**Retract goes last, beneath both panels.** The structure came from an option
that placed it directly under the rationale; the ordering came from one that
made the reader scroll past the receipts first. Retraction reaches every mirror
on its next delta pull, so the evidence should be passed on the way to the
button, not after it.

**Rejected: progressive disclosure** — claim and rationale visible, everything
else behind one expander. Shortest pane by far, and it hides the consensus
figures, which are the entire basis for trusting the claim.

---

## Section 4 — `/machines` *(approved)*

The table becomes rows in the list's vocabulary: `Key` plated teal for live, red
for revoked, `Sleep` for never used. Same row grammar as lessons, so the two
screens read as one product rather than two.

**The one-time reveal gets `Key` at 48.** It is the single most consequential
moment in the app — a credential shown once and never again — and it currently
looks like every other panel on the page. Its *behavior* is already carefully
designed (focus trap, explicit dismissal, no timeout) and does not change here;
only its weight does.

---

## Section 5 — Accessibility *(approved)*

This absorbs `onlooker-8pt`, which was filed as one bead precisely because every
item applies identically to `MachinesPage`'s revoke and `LessonDetail`'s retract.

**The current pending treatment is the cause of the worst defect.** `Button` sets
the `disabled` attribute while loading, and disabling a focused element drops
focus to `<body>` — mid-action, in a destructive flow. So pending uses
`aria-busy` and `aria-disabled` with a guarded handler, never the `disabled`
attribute. Focus stays where the user put it.

This is a behavior change and needs its own test: `ui.tsx`'s existing comment
says `loading` implies `disabled` deliberately, so the reason for the reversal
has to be recorded next to the code.

**`ConfirmAction` in `ui.tsx`** owns the arm-then-confirm flow now duplicated
across both pages. It moves focus to the confirm button when armed, returns it to
the trigger on cancel, and wires the question to the button via
`aria-describedby` — today a screen reader reaching "Yes, retract" hears no
question at all.

**Announcements.** Filter results and appended rows report through a polite live
region; loading states get `role="status"`. Three of these are WCAG 2.2 AA
(4.1.3 Status Messages). The project has no stated AA commitment — that was
confirmed on 2026-08-27 — so they ship here because they are cheap while the
components are open, not because they are obligatory.

---

## Section 6 — Attribution *(approved)*

Icons are by **Crusenho Agus Hennihuno** (<https://crusenho.itch.io>), **CC BY
4.0**. The brand doc states plainly that credit "must appear wherever the icons
ship — website footer and the app's about surface at minimum," that this is a
legal obligation rather than a courtesy, and that it "is not satisfied by a line
in a README nobody renders."

`apps/web` has no about surface and ships no attribution. **The first rendered
icon creates an obligation that is currently unmet**, so the credit surface is in
scope for this work and not a follow-up.

**It goes in a footer on `AppShell`.** The credit then appears on every
authenticated page for as long as the icons are on screen, which is what "wherever
the icons ship" asks for, and it needs no new route to maintain.

**Rejected: its own `/about` route.** A page nobody visits satisfies the letter
of the condition and not much else, and it is one more route to keep alive.

**Rejected: inside Settings.** Settings only gets the font correction in this
pass, and burying a license condition two clicks deep in a low-traffic screen is
the same mistake as putting it in a README.

---

## Section 7 — Testing *(approved)*

This is a visual refactor of code that shipped with 271 passing tests. **Behavior
does not change**, so the posture is that every existing test still passes, and
any test needing its assertion changed is a signal to stop and look rather than a
chore to grind through.

Known at risk, and what each would mean:

- **Heading-level queries in the detail pane.** The two-panel restructure moves
  headings. A failure here is expected and the assertion should be updated to the
  new structure — but the heading *order* must stay skip-free, which a previous
  review already had to fix once.
- **`getAllByText("Retracted").length === 2`.** A previous review noted these are
  structurally pinned by a one-item fixture rather than by scoping. If they break,
  it means the row and the detail diverged — which is exactly what they exist to
  catch, and not something to loosen.
- **`getByRole("button", { name: /retract/i })`.** Extracting `ConfirmAction`
  must not change the accessible names of either control.

**The display-face correction is invisible to the suite.** Checked on
2026-08-28: no test in `apps/web/src/__tests__` or `packages/brand` asserts on
`fontSize` or `fontFamily`. That is convenient for landing piece 2 and it is also
the reason the app could render its pixel face at five illegal sizes across nine
files without a single test noticing. The correction ships unguarded; the thing
that keeps it correct afterwards is the scale token, not a test.

New tests required, not optional: focus is retained when a pending button is
activated; focus moves to the confirm button when armed and returns to the
trigger on cancel; the confirm question is associated with its button.

---

## Section 8 — Sequencing

Six pieces, each independently reviewable. The system lands before anything
consumes it.

| # | What | Visible? |
|---|---|---|
| 1 | Scales in `tokens.css`; `index.ts` icon union; `Icon.tsx`; the two brand-doc corrections | No |
| 2 | The display-face correction, everywhere it is wrong | Yes, subtly |
| 3 | `ConfirmAction`, the `aria-busy` pending change, live regions | Behavior only |
| 4 | Attribution footer on `AppShell` | Yes |
| 5 | `/lessons` — both panes | Yes |
| 6 | `/machines` — rows and the reveal | Yes |

Piece 2 is its own step rather than folded into 5 and 6 because it reaches nine
files, five of which get no other change, and because it is the one piece that
improves the app on its own merits even if everything after it were abandoned. It
is also the only piece that touches the auth pages, so a regression there is
attributable to one commit rather than buried in a redesign.

Piece 4 lands before 5 and 6 because it is what makes rendering an icon lawful.
Pieces 5 and 6 could swap; lessons first because it is the surface the complaint
was about.

---

## Open questions

None. The three carried out of the design conversation were settled on
2026-08-28: `Restart` takes `superseded` and the mapping is written back into the
brand doc (Section 2); the display-face correction covers every file that
violates it rather than only the two redesigned screens (Boundary, Section 1);
and the attribution lives in an `AppShell` footer (Section 6).

One thing to watch during implementation rather than decide now: the font
correction touches five files whose visual design is otherwise untouched. If
correcting a label's face there changes its size enough to disturb layout, that
is a signal the label was load-bearing at an illegal size — worth reporting, not
worth silently compensating for with a spacing tweak.
