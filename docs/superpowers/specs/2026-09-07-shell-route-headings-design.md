# Shell Route Headings — Design

Beads: `onlooker-eqb`, `onlooker-8ce`. Applies to `apps/web`.

Follow-on to `2026-08-30-account-pages-in-the-shell-design.md`, whose review
raised both beads and deferred both — "it is a four-page question and that
branch had scope for two."

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-07 and are
decisions rather than proposals. Code references were read on this machine on
2026-09-07 against `main` at `60ba5ef`.

## Boundary *(approved)*

**In scope:** `apps/web/src/components/AppShell.tsx`,
`apps/web/src/components/ui.tsx` (`Button`),
`apps/web/src/pages/SettingsPage.tsx`, `apps/web/src/pages/ProfilePage.tsx`,
`apps/web/src/pages/LessonDetail.tsx`, and their tests.

**Out of scope:** `LessonsPage`, `MachinesPage` and `ActivityPage` source —
they gain an `h1` without being edited, which is the point of Section 2. The
non-shell routes keep having no page heading; nothing in either bead concerns
them.

---

## The state this corrects *(measured, not assumed)*

`onlooker-eqb` says "the four routes that render `AppShell`". There are **five**.
`AppShell`'s `SECTIONS` lists `/lessons`, `/machines`, `/activity`, `/settings`
and `/profile`; `/activity` was added on 2026-08-31, the day after the bead was
filed. Any fix scoped to the bead's list would have left the newest route out.

| Route | Page `h1` today | Outline starts at |
|---|---|---|
| `/lessons` | none | `h2` "The pool" |
| `/lessons/:id` | `h1` — the lesson's claim | `h1` → `h2` → `h3` |
| `/machines` | none | `h2` "Mint a machine token" |
| `/activity` | none | `h2` — **a date**, from `Panel title={group.day}` |
| `/settings` | `h1` "Account settings", unstyled | `h1` |
| `/profile` | none | `h2` "Profile" |

The gap is unevenly distributed, and worse than the bead describes. On
`/profile` the page's name at least survives at `h2`. On **`/machines` and
`/activity` the page's identity appears nowhere in the heading outline** —
`/activity`'s first heading is a date. Only the nav's `aria-current` says where
you are, and a heading list is a primary way to orient.

**A policy already existed; it was undocumented and applied once.**
`LessonDetail.tsx:36-48` states its intended outline in a comment — "h1 (the
claim) -> h2 (the panel) -> h3 (the field) - not a skip". So the bead's "no
document states which is intended" is half right: one answer was implemented and
reasoned about on exactly one surface, and never generalized.

---

## Section 1 — One `h1` per shell route, named for the section *(approved)*

Every route that renders `AppShell` carries exactly one `h1`, whose text is
exactly that route's `SECTIONS` label: **Lessons, Machines, Activity, Settings,
Profile**.

**Matching the nav label is the decision, not an accident.** Today the nav
announces "Settings, current page" and the first heading then says "Account
settings" — a small stumble every time, for the one user who most needs the two
to agree. Making them identical also turns the policy into something a test can
check by equality rather than by inspection.

The cost is a copy change on a shipped page: "Account settings" becomes
"Settings", losing a little specificity. Accepted, because the nav item next to
it already says `Settings` and the two disagreeing is the actual complaint.

**Rejected: a visually-hidden label `h1`.** It fixes the outline without
touching any visual design, and is standard practice. Rejected because it puts a
heading in the accessibility tree that nothing on screen corresponds to, and
this codebase is unusually careful about visible and non-visible structure
agreeing — `AppShell`'s nav uses an underline rather than color alone, `Panel`'s
icons are `alt=""` because the visible title carries the name.

**Rejected: no page-level `h1` anywhere.** Consistent and the smallest diff, and
it would keep `LessonDetail`'s outline untouched. Rejected because it accepts
the defect: `/machines` and `/activity` would still name themselves nowhere.

---

## Section 2 — `AppShell` renders it, not the pages *(approved)*

`AppShell` renders the `h1` by looking up the current pathname in `SECTIONS`.
The five pages do not render one.

This follows from Section 1. Once the `h1` must equal the nav label, and the
label already lives in `SECTIONS`, having five pages each hand-copy a string
that must match is a drift hazard with no upside. Rendering it from the one
place the label is defined makes the policy **structurally true rather than
conventionally followed**: five pages cannot disagree, and a sixth shell route
gets its heading by existing rather than by someone remembering.

**It also dissolves half of `onlooker-8ce` instead of fixing it.** That bead's
first item is "the page `<h1>` is entirely unstyled, so it renders at browser
default beside Panel's `--font-data` uppercase `h2` headings". With one `h1` in
one place there is exactly one type treatment to get right, and no page can
introduce an unstyled one later. `SettingsPage.tsx:55` is deleted rather than
restyled.

**Matching.** Exact match on `to`, or a `to`-plus-`/` prefix, so `/lessons/:id`
resolves to Lessons. Prefix alone would be wrong in principle — `/lessons` would
match a future `/lessons-archive` — and the `/` guard costs nothing.

**Placement.** Inside `<main>`, after `SessionExpiryBanner` and immediately
above `{children}`. The banner is session chrome rather than page content and
warns that a token refresh failed; someone who needs it should not have to pass
the page title first.

**Type.** `--font-body` at `--text-body-lg`, reusing `LessonDetail`'s existing
page-heading treatment rather than inventing a second one. Its comment already
argues the case: a page heading here "is a sentence, not chrome, and pixel type
is measurably harder to read at length: it leads by size and weight here, not by
face."

**A known limit, stated so it is not discovered later.** A route that renders
`AppShell` but has no `SECTIONS` entry gets no `h1`, and the test in Section 6
enumerates `SECTIONS`, so it would not catch that. This is judged acceptable:
every shell route today is a nav destination, and a shell route deliberately
absent from the nav would be a larger design question than this bead. It fails
by rendering nothing rather than by throwing.

---

## Section 3 — Per-page consequences *(approved)*

`/lessons`, `/machines` and `/activity` gain an `h1` with no edit to their
source.

**`SettingsPage`** loses `<h1>Account settings</h1>` at `:55`.

**`ProfilePage`**'s `Panel title="Profile"` would sit directly under an `h1`
reading "Profile". It retitles to **"Account details"**, which is what it holds:
Name, Email, Account created, Last login.

**Not untitled.** `Panel` renders its `icon` *inside* the `h2` (`ui.tsx:153-168`),
so an untitled panel silently drops CatHead. The retitle keeps the icon; leaving
the title empty would have been a quiet visual regression.

---

## Section 4 — `LessonDetail` shifts down one level *(approved)*

Claim `h1` → `h2`, panel `h2` → `h3`, field `h3` → `h4`. The outline on
`/lessons/:id` becomes `h1` Lessons → `h2` The pool → `h2` claim → `h3` panel →
`h4` field. Skip-free, and one `h1`.

`LessonDetail.tsx:36-48` documents the old outline explicitly, so that comment is
rewritten rather than left to contradict the code it sits above. The reasoning it
carries — that the nesting is correct document order rather than a skip — stays
true at the new levels and is worth keeping.

**Why the claim is not the page `h1`.** `/lessons/:id` is a layout route:
`LessonsPage` renders the list and an `Outlet` for the detail, two panes of one
page. The page is Lessons; the claim titles a pane within it. Keeping the claim
at `h1` while the list gained one would put two `h1`s on the route.

---

## Section 5 — A ghost variant for `Button` *(approved)*

`Button`'s `variant` widens from `"primary" | "danger"` to
`"primary" | "danger" | "ghost" | "ghost-danger"`. The resend-verification
control uses `ghost`, `DeleteAccountSection`'s delete trigger uses
`ghost-danger`, and its cancel uses `ghost`.

**Flat variant strings rather than a separate `tone` prop.** `ui.tsx` reserves
that word: its `Panel` comment records that `tone` already means "which of two
constant plate FILLS backs an icon" in this file, and that `variant` is the name
that follows `Button`. A second meaning for `tone` here would be exactly the
collision that comment exists to prevent.

`ui.tsx`'s `Button` offers only `primary` and `danger`, both filled plates. But
`SettingsPage` already hand-rolls the same ghost treatment twice inside
`DeleteAccountSection` — transparent background, `2px solid` border,
`borderRadius: 0` — differing only in color. So the system does not own a
treatment it already uses twice, and `onlooker-8ce` asks for a third instance of
it.

Converting all three leaves the file with one implementation rather than three
copies. The existing contrast reasoning moves into the variant as comments
rather than being dropped: `--ink-dim` clears 3:1 as a border at 8.06/6.56, and a
filled danger button on the delete *trigger* "would outrank the actual confirm".

**Rejected: a plain filled `Button` for resend.** Literally "the design system's
button treatment", and the smallest change. Rejected because a filled teal plate
for *Resend verification email*, inside a gold notice panel, three panels above
two deliberately quieter buttons, recreates the visual-weight mismatch the bead
is complaining about in the other direction.

**Rejected: the variant for resend only.** Would leave a ghost variant in the
design system with two inline copies of the same treatment a few lines below it
— worse than the three copies that exist now.

---

## Section 6 — Testing *(approved)*

**Every shell route's `h1` equals its `SECTIONS` label**, driven off `SECTIONS`
itself rather than a hand-written list, so a route added to the nav is covered
without anyone remembering to extend the test. This is the assertion that makes
Section 1 a policy rather than a description.

**`/lessons/:id` has exactly one `h1`.** The regression this design is most
likely to suffer is someone re-promoting the claim, and a test that only counted
headings on `/lessons` would not see it.

**`LessonDetail`'s outline is skip-free at its new levels**, which is what
Section 4 changes and the only place levels moved.

Existing heading-based queries elsewhere in the suite will need updating where
they assert on levels that moved; that is expected work, not a signal of a wrong
design.

---

## Consequences

**`onlooker-eqb` closes**, with a stated policy — its acceptance criterion —
covering five routes rather than the four it named.

**`onlooker-8ce` closes.** Its first item is dissolved by Section 2 rather than
fixed in place; its second is Section 5.

**`2026-08-29-machines-reveal-and-a11y-design.md` needs no amendment.** Its
Section 5 concerns list semantics on `/machines`, not headings, and is unaffected.
