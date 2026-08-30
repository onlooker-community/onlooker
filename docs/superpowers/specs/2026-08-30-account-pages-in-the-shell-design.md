# Account Pages in the Shell — Design

Bead: `onlooker-e5a`. Narrows `onlooker-zq1`. Applies to `apps/web`.

Follow-on to `2026-08-28-app-visual-language-design.md`, which deferred exactly
this work and said why:

> The full visual treatment of the auth pages, `SettingsPage` and `ProfilePage` —
> they get the font fix and keep their current design. … the language has to
> exist before it can be applied, and it is cheaper to prove it on two screens
> than on nine.

The language now exists and has been proven on `/lessons` and `/machines`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-30 and are
decisions rather than proposals. Measurements were taken on this machine on
2026-08-30 against `main` at `469e968`.

## Boundary *(approved)*

**In scope:** `apps/web/src/pages/SettingsPage.tsx`,
`apps/web/src/pages/ProfilePage.tsx`, their routes in `App.tsx`, and one
additive change to `Panel` in `apps/web/src/components/ui.tsx`.

**Out of scope:** all five auth pages, `form.tsx`, `AuthCard`, `AppShell.tsx`,
`packages/brand`, and `apps/website`.

Seven pages entered scope and five leave it needing nothing. That is a finding
rather than a narrowing of the request — see *The auth flow is already aligned*.

---

## The problem is structural, not cosmetic *(approved)*

`/settings` and `/profile` do not render `AppShell`. A signed-in person who
navigates to either loses the app's navigation entirely and has to use
browser-back to get out. `SettingsPage` hand-rolls nothing to replace it;
`ProfilePage` hand-rolls a two-link `<nav>`.

This is anticipated work, not an oversight. `AppShell` already declares slots and
icons for both, and says so:

```
// /lessons and /machines route through it today; /settings and /profile do not yet.
const SECTIONS = [
  { to: "/lessons",  label: "Lessons",  icon: "ChestTreasure" },
  { to: "/machines", label: "Machines", icon: "Key" },
  { to: "/settings", label: "Settings", icon: "Gear" },
  { to: "/profile",  label: "Profile",  icon: "CatHead" },
]
```

What makes these pages feel unlike the rest of the app is that they are orphaned
from its chrome. Their borders and colors are a much smaller part of it, and
addressing only those would leave the felt problem in place.

### A second problem, found while scoping

Both pages show the account overview, and they have already drifted:

| | Settings (`ProfileOverview`) | Profile |
|---|---|---|
| Name | yes | yes |
| Email | yes | yes |
| Created | "Member since" | "Account created" |
| Last login | — | yes |

Two homes for one fact, disagreeing on a label and on whether last login is worth
showing.

---

## The auth flow is already aligned *(approved)*

`LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage` and
`VerifyEmailPage` all share `AuthCard`, `TextField`, `SubmitButton`,
`FormMessage` and `FormLink`. They are consistent with each other and already
wear the brand.

The 2026-08-28 spec's statement that `LoginPage` is "hand-rolled without even
using `TextField`" is **stale**. `form.tsx` was built after it and the auth pages
adopted it.

`AuthCard` differs from `Panel` deliberately, and the differences carry
justification in the source:

- Its border is `2px solid var(--ink-dim)`, not `PALETTE.border`, because the
  card's panel fill is only 1.70/1.37 against the page it floats on — that border
  is the sole edge cue, so it needs real contrast margin rather than a threshold
  pass.
- It carries a hard `6px 6px 0` offset shadow. `Panel` has none. "The 16-bit look
  has no soft shadows."
- Its title is `--font-body` at `--text-body-lg`; `Panel` titles are uppercase
  `--font-data`.

A pre-auth page has no chrome and should read as a centered card. An in-app
section should read as a panel in a frame. Converging them would overwrite
measured decisions to make two different contexts look the same, so this design
does not touch them.

---

## Settings *(approved)*

Wrap in `AppShell`. Replace the four hand-rolled `<section style={sectionStyle}>`
blocks with `Panel`, which supplies the border, the uppercase `--font-data`
heading, and an icon slot. Icons come from the brand's existing set:

| Section | Icon |
|---|---|
| Verify your email | `Letter` |
| Update profile | `Pencil` |
| Change password | `Locked` |
| Delete account | `Trashbin` |

`Locked` rather than `Key`: `Key` is already the nav icon for `/machines`, and
reusing it for an unrelated section would make the icon mean two things.

Delete `ProfileOverview` and its `Row` helper. Settings keeps only what a person
acts on: verify email, update profile, change password, delete account.

**The comment at line 38 becomes false and must be corrected, not deleted.** It
currently reads "/settings renders without AppShell, so a reveal opened on
/machines can still be on screen here." Once AppShell wraps the page the premise
is wrong, but the `useReveal()` call it explains is still required — the
delete-account handler calls `dismiss()` before `logout()`, for the reason its
own comment gives.

## Profile *(approved)*

Wrap in `AppShell` and delete the hand-rolled `<nav>`. AppShell supplies
navigation, which is the entire point of the change; leaving a second set of
links would be worse than the current state.

Rebuild the `<dl>` inside a `Panel` titled with `CatHead`, matching the icon its
nav entry already uses. Keep all four fields, including `Last login` — Profile
now owns the overview, and dropping a field while absorbing the responsibility
would lose information.

Replace the unstyled `<button>` in the error branch with `Button` from `ui.tsx`.

## One shared-component change *(approved)*

`Panel` gains an optional `accent?: "gold" | "red"`. Two Settings sections carry
a colored border that means something — `--gold` for "verify your email", `--red`
for "delete account" — and moving to a `Panel` with a fixed `PALETTE.border`
would silently discard that signal.

**Named `accent`, not `tone`, and the distinction matters.** `ui.tsx` already
uses `tone` on two components — required on `Plate`, optional on `EmptyState` —
and in both it means the same thing: which of exactly two *fill* colors backs an
icon, `"teal" | "red"`. Panel's colored edge is a different axis with different
values. Reusing `tone` would make one prop name mean two things in one file, and
the union would have to widen to `"teal" | "red" | "gold"` where two of the three
are invalid for any given component.

The change is additive: existing `Panel` callers on `/lessons` and `/machines`
pass no `accent` and render exactly as they do now.

---

## Accessibility, stated precisely *(approved)*

`AppShell` sets `inert={revealed ? "" : undefined}` on its content, so routing
these pages through it means a token reveal opened on `/machines` now marks the
page behind it inert on `/settings` and `/profile` too.

**This narrows `onlooker-zq1`; it does not close it.** That bead names four
routes without `AppShell` — `/settings`, `/profile`, `/` and `/login`. This work
covers two. The remaining two still rely on `aria-modal`, which is advisory,
though `TokenReveal`'s focus trap continues to hold for Tab on all of them.

It also does not preempt `zq1`'s preferred fix, which is hoisting `inert` to
something wrapping the whole route table. If that lands later it supersedes this
partial coverage rather than conflicting with it.

## Testing *(approved)*

- Extend `app-shell.test.tsx`, which already asserts the nav hrefs, to assert
  that `/settings` and `/profile` render the shell.
- Add a test that `SettingsPage` no longer renders a Profile heading, so the
  dedupe cannot silently regress into two homes for one fact again.
- `app-error-boundary.test.tsx` already renders at `/profile` three times and
  will exercise the new structure without changes.
- `reveal-across-the-app.test.tsx` covers the reveal's behavior across routes and
  should be checked for assertions that depend on `/settings` lacking a shell.

## Rollback

One commit touching two pages, one route file, and one additive component
parameter. `git revert` restores the previous state; nothing here changes data,
API calls, or auth behavior.

## Open questions

None blocking. Whether `AuthCard` and `Panel` should eventually converge is a
real question and deliberately left open — it needs its own decision with fresh
eyes rather than being settled as a side effect of this work.
