# The Machines Surface: Reveal Lifetime and Accessibility — Design

Closes `onlooker-kxe`, `onlooker-1bz`, `onlooker-aky` and `onlooker-tj9`.

Applies to `apps/web`: `TokenReveal`, `MachinesPage`, `AppShell`, `App`, and a
new reveal provider.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-29 and are
decisions rather than proposals. Open questions are collected at the end.

## Boundary

**In scope:** where a revealed machine token's state lives, what destroys it,
making the background unreachable to assistive technology while the reveal is
open, and the focus and announcement gaps in the revoke flow.

**Out of scope:** the reveal's visual design, the mint flow itself, and
`LessonsPage`. `LessonsPage` is unaffected by the list-semantics work — its
rows are links, which already carry their own boundaries.

**Explicitly rejected:** persisting the token to `sessionStorage` or
`localStorage`. See Section 1.

---

## Section 0 — What is already true *(context, not decisions)*

**Two of these four beads are the same bug.** `onlooker-kxe` (a session
expiring while the reveal is open) and `onlooker-1bz` (an in-app Back) both end
with the revealed token gone. The cause in both is that the token lives in
`MachinesPage`'s `useState`, so *anything* that unmounts the page destroys it —
a route change, an auth redirect, a re-render of the tree above it. Both beads
reached that conclusion independently; `kxe` says fixing it "means deciding
where the revealed token's state should live, which is bigger than that PR."

**The component tree, verified on 2026-08-29:**

```
BrowserRouter
  AuthProvider
    App
      Routes
        Route /machines
          RequireAuth        ← redirects on expiry; unmounts everything below
            AppShell
              MachinesPage
                TokenReveal  ← position: fixed, but a DOM descendant of <main>
```

`TokenReveal` covers the viewport with `position: fixed; inset: 0`, but it is a
descendant of `AppShell`'s `<main>`. That is why `onlooker-aky` cannot be fixed
by marking the shell `inert`: doing so would inert the dialog too.

**A prior attempt at `onlooker-1bz` was reverted, and its lesson is binding.** A
popstate guard pushed a sentinel history entry on mount and re-pushed on every
popstate. It kept the dialog up, but never unwound what it pushed — leaving one
orphan entry per dismissal and one more per Back attempted while open. The next
real Back press then popped to an identical URL and appeared to do nothing.
Breaking Back for the whole session was judged worse than a recoverable token
loss in one flow. **This design does not reattempt that approach.**

`useBlocker` is not available: `main.tsx` mounts `BrowserRouter`, not a data
router.

**The revoked row survives.** `action(machine)` returns `null` once
`revoked_at` is set, which is what disarms a confirm after a successful revoke.
The row itself is kept deliberately — "that is how a person sees that they
revoked it" — so only the `ConfirmAction` inside it unmounts. It unmounts while
its confirm button holds focus, which drops focus to `<body>`.

**A machine token does not depend on the browser session.** It is minted once,
shown once, and recoverable only by revoking the machine and minting another.
It remains valid after the browser session that created it has expired.

---

## Section 1 — Where the reveal lives *(approved)*

A `RevealProvider` mounted **inside `AuthProvider`, wrapping `<Routes>`**. It
holds the minted machine and a dismiss function. `MachinesPage` sets it on a
successful mint and reads nothing back.

That placement is chosen against the tree above: it is below `AuthProvider`, so
it can react to logout, and above `Routes`, so neither a route change nor
`RequireAuth`'s redirect can unmount it. Those are `onlooker-1bz` and
`onlooker-kxe` respectively, and one placement answers both.

`TokenReveal` renders from the provider through a **portal to `document.body`**
rather than inline in the page. The portal is what makes Section 3 possible.

**This placement depends on an earlier fix, and that dependency is invisible.**
`App` wraps `<Routes>` in an `ErrorBoundary` that takes `resetKey={location.pathname}`
rather than `key={location.pathname}`. `resetKey` clears caught state without
remounting; `key` would remount the whole subtree on every navigation — which
would unmount the provider and bring `onlooker-1bz` straight back. Measured on
2026-08-29: a revert to `key=` fails exactly one test, and it is not one of
this design's — it is `"does not refetch the pool when clicking from one lesson
to another"` in `lessons-page.test.tsx`, from unrelated earlier work. The
dependency is therefore guarded only coincidentally, from another feature. That `key` → `resetKey`
change was made during `onlooker-yfw` for an unrelated reason. Anyone reverting
it breaks this. Verified on 2026-08-29 that `App.tsx:31` still reads `resetKey`.

**In memory only. Never `sessionStorage`, never `localStorage`.** A full page
reload still loses the token, and `beforeunload` already warns before that
happens. Writing a live credential to disk to avoid a warning the user has
already been given would be a worse trade than the bug being fixed.

**Rejected: blocking the navigation instead.** Keeping the state where it is and
guarding what would destroy it means reattempting the reverted popstate guard
for `1bz`, and deferring an authentication-expiry redirect for `kxe`. The first
is documented as having broken Back for the whole session; the second means
holding a user in an authenticated view after their session has ended.

---

## Section 2 — What ends the reveal *(approved)*

Two things, and nothing else:

1. **Explicit dismissal.** The user says they have saved it.
2. **Logout.** `AuthProvider` sits above `RevealProvider`, so this does not
   happen for free — it must be wired deliberately, and it gets its own test.
   A credential left on screen after a deliberate sign-out is not acceptable.

**Session expiry does not end it, and neither does navigation.** That is the
entire point of the two beads. The token is still valid after the session that
minted it expires, and losing it costs a revoke-and-mint cycle.

**Rejected: a lifetime cap.** An auto-dismiss after N minutes bounds how long an
unattended screen can display a credential, which is a real concern — `kxe`
itself observes that "the reveal is exactly when someone walks away to open a
password manager." It is rejected because silently destroying an unsaved
credential is the bug being fixed, and a timeout is that same bug with a delay.
The exposure is the same as any authenticated page left open, and the token is
one-time and revocable by design.

**Rejected: masking behind re-authentication after expiry.** More moving parts,
and thin value when the person who minted the token is the one sitting there.

---

## Section 3 — The background must be unreachable *(approved)*

While a reveal is open, `AppShell` takes the `inert` attribute.

This works only because of Section 1's portal. `inert` removes a subtree from
the accessibility tree and from focus; applied to `AppShell` while the dialog
was still a descendant of `<main>`, it would remove the dialog as well.

`TokenReveal` already sets `role="dialog"`, `aria-modal="true"` and traps
keyboard focus. `aria-modal` alone is not enough: it is advisory, and a screen
reader's virtual cursor can still browse into the `AppShell` nav that the focus
trap exists to protect. `onlooker-aky` calls this "the same class of escape as
the forward-Tab gap, different input method."

`inert` rather than `aria-hidden`, because `inert` removes focusability too. The
two would otherwise need to be kept in step by hand.

---

## Section 4 — The revoke flow *(approved)*

**Focus.** A `tabIndex={-1}` ref on the machine row, focused once the revoke
settles. The row is a valid target precisely because revoked rows persist by
design — only the `ConfirmAction` inside unmounts. Focusing the row keeps the
person where they were; focusing the section heading would also work but moves
them further than the action did.

**Announcement.** A `role="status"` region naming the machine that was revoked.
Nothing currently announces that the action landed.

The live region must be **present in the DOM before it has content**. A region
mounted together with its message is the shape screen readers do not reliably
announce — the same defect corrected on `LessonDetail` during `onlooker-yfw`.

---

## Section 5 — List semantics *(approved)*

`role="list"` on the machines container, `role="listitem"` on each row.

**Not a restored `<table>`.** The markup was a table before the visual-language
pass, with four `th scope=col` and a `th scope=row` per machine. But
`onlooker-tj9`'s own analysis is that "the visible Created/Last used labels
recovered what the column headers did; nothing recovered the row boundaries."
Only the boundaries and the item count are actually missing. A list restores
exactly those, and does not undo a styling decision that was made deliberately.

---

## Section 6 — Testing

**The two that would silently regress:**

- **Logout clears the reveal.** The one edge that does not come for free from
  the provider's placement. A test that logs out with a reveal open and asserts
  the dialog is gone.
- **The reveal survives an auth redirect.** Simulate the terminal-401 path that
  calls `expireSession()`, and assert the dialog is still mounted. Without this,
  a later refactor that moves the provider back inside `RequireAuth` passes
  every other test.

**The rest:**

- The reveal survives an in-app route change (`1bz`). This is also the test
  that catches an `ErrorBoundary` reverted from `resetKey` to `key`, per
  Section 1 — worth a comment saying so, because the failure would otherwise
  look unrelated to the boundary.
- `AppShell` carries `inert` while open and loses it on dismissal (`aky`).
- Focus lands on the row after a revoke, rather than on `<body>` (`tj9`).
- The status region exists before it has content, and names the machine.
- Each row is a `listitem` within a `list`.

**A note on what a passing test proves here.** Several of these assert on
attributes rather than on behavior a person would experience — `inert` being
present is not the same as a screen reader being unable to reach the nav. Where
a test asserts an attribute, it should be written so that removing the code
under test makes it fail, and that should be confirmed by removing it rather
than assumed.

---

## Section 7 — Sequencing

1. `RevealProvider` and the portal (Sections 1–2). Everything else depends on
   the dialog no longer living inside the page.
2. `inert` on `AppShell` (Section 3). Requires the portal.
3. The revoke focus and announcement (Section 4). Independent of 1–3.
4. List semantics (Section 5). Independent of everything.

Tasks 3 and 4 touch `MachinesPage` but not the reveal, so they can be reordered
freely. Tasks 1 and 2 cannot.

---

## Open questions

None. The two decisions carried out of the design conversation — preserve the
token rather than prevent the navigation, and give the preserved reveal no
lifetime cap — are recorded in Sections 1 and 2 with the alternatives that were
rejected and why.

One thing to watch during implementation rather than decide now: `inert` needs a
polyfill in older browsers, and React's support for it as a prop varies by
version. If the installed React does not pass `inert` through, set it with a ref
rather than reaching for a polyfill — the attribute has been supported in every
current browser since 2023, and the app's floor is set elsewhere.
