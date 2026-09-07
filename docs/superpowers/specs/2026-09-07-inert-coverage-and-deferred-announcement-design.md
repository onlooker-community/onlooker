# Inert Coverage and the Deferred Announcement — Design

Beads: `onlooker-zq1`, `onlooker-5o4`. Applies to `apps/web`.

Follow-on to `2026-08-29-machines-reveal-and-a11y-design.md`, which introduced
both halves of this problem without connecting them. That document's
implementation order says of its Section 4:

> 3. The revoke focus and announcement (Section 4). Independent of 1–3.

Section 3 puts `inert` on `AppShell`. Section 4 puts a `role="status"` region
inside `AppShell`. They are not independent, and `onlooker-5o4` is the
interaction neither section considered.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-07 and are
decisions rather than proposals. Code references were read on this machine on
2026-09-07 against `main` at `4963698`.

## Boundary *(approved)*

**In scope:** `apps/web/src/reveal.tsx`, `apps/web/src/App.tsx`,
`apps/web/src/components/AppShell.tsx`, `apps/web/src/pages/MachinesPage.tsx`,
their tests, and an amendment to
`docs/superpowers/specs/2026-08-29-machines-reveal-and-a11y-design.md`.

**Out of scope:** `TokenReveal.tsx` — its focus trap, its `beforeunload`
handler and its dialog semantics are all unchanged. The other three live
regions in the app (`form.tsx:317`, `LessonDetail.tsx:249`,
`LessonsPage.tsx:325`) are out of scope; see *Why this is not generalized*.

---

## Two beads, one root, opposite directions *(approved)*

`AppShell` owns `inert` (`AppShell.tsx:66`). Everything below follows from
that single placement.

**`onlooker-zq1`.** Routes that do not render `AppShell` get no `inert` at
all. The reveal survives route changes by design — that is what
`onlooker-1bz` fixed — so it can follow a person onto a route where nothing
behind it is inert. There, `aria-modal` is the only barrier, and `aria-modal`
is advisory: a screen reader's virtual cursor browses straight through it.

**`onlooker-5o4`.** The revoke announcement at `MachinesPage.tsx:172` is a
`role="status"` region *inside* that same subtree. When a reveal opens while a
revoke is in flight, `setRevokedName` writes into a region `inert` has just
removed from the accessibility tree. The announcement is dropped with no sign.

These pull in opposite directions. Hoisting `inert` — the fix `zq1` proposes —
does not fix `5o4`; it keeps the region swallowed and extends the swallowing to
every route. `5o4` needs the announcement to escape `inert`, or to wait for it.
Fixing either one alone leaves the other worse or unchanged, which is why they
are designed together.

---

## Section 1 — Hoist `inert` to cover every route *(approved)*

`AppShell` stops setting `inert`. A new `InertWhileRevealed` component in
`reveal.tsx` wraps `<Routes>` in `App.tsx`, inside `RevealProvider` and as a
sibling of `RevealHost`. The `declare module "react"` typing shim moves out of
`AppShell` with it, staying in one place as its comment asks.

**Coverage is six routes, not two.** `onlooker-zq1`'s description names `/`,
`/login`, `/settings` and `/profile`; the latter two were resolved by
`onlooker-e5a`. Its correction note records the exhaustive residual, which this
covers along with the `*` 404 route:

| Route | Renders `AppShell` |
|---|---|
| `/` | no |
| `/login` | no |
| `/signup` | no |
| `/forgot-password` | no |
| `/reset-password/:token` | no |
| `/verify-email/:token` | no |
| `*` (404) | no |

**Why this is safe, and it is the same reason as before.** `RevealHost`
renders through `createPortal` into `document.body`, so the dialog is not a
descendant of `<Routes>` and cannot be inerted by a wrapper around it. This is
not a new invariant — `2026-08-29`'s Section 3 depends on it, and
`onlooker-zq1`'s note verified it holds. Hoisting does not weaken it, because
the portal target is `document.body` rather than any node inside the render
tree.

**`AppShell`'s `dismiss()` in `handleLogout` stays.** Its comment argues the
call is the only thing clearing the token on a browser that ignores `inert`,
and that `inert` makes it defense-in-depth. Both halves survive the hoist
unchanged.

### Why a wrapper node rather than `#root` *(approved)*

`#root` is a direct child of `<body>` (`index.html`), and `RevealHost` portals
to `document.body` — so the dialog is a *sibling* of `#root`. Setting `inert`
on `#root` in an effect would therefore also cover every route and also leave
the dialog reachable, with no new DOM node.

It is rejected for a testing reason. React Testing Library's `render()` mounts
into a fresh `div` appended to `document.body`, not into `#root`. An effect
targeting `#root` by id would silently no-op in every test in this suite: the
attribute would never appear, and a test asserting on it would be asserting
against a node the app never touched.

That is the same class of failure already documented at `AppShell.tsx:63` —
`inert={true}` renders nothing and leaves the code looking correct — and that
one was caught only because it was measured. A wrapper node inside the render
tree is verifiable in jsdom, so it is preferred.

**Layout risk was checked, not assumed.** No non-shell page uses `100vh`,
`minHeight` or a `height` chain that an unstyled wrapper could break, and
`AppShell` carries its own `minHeight: 100vh` on the div below it.

---

## Section 2 — Defer the revoke announcement *(approved)*

`MachinesPage` gains a pending-name ref. On a successful revoke:

- No reveal open — `setRevokedName(machine.name)` as today.
- Reveal open — park the name in the ref instead, announce nothing.

An effect watching `revealed` flushes a parked name into state when the dialog
closes.

**The flush must be a mutation performed while the region is live.** Parking
the text into state early and letting the region become un-inert on dismissal
would not work: a node re-entering the accessibility tree with content it
already had is not a change, and no screen reader announces it. The
announcement exists only if the text arrives *after* the subtree is live. This
is the entire mechanism and the part an implementation can get backwards while
still looking correct.

**Why deferral rather than escaping `inert`.** `role="status"` is polite by
definition — it is the live-region politeness level that promises never to
interrupt. The reveal is the highest-stakes moment in the application: a
credential displayed exactly once and unrecoverable if missed, as the dialog
itself says in as many words. Firing an unrelated announcement into that
moment honors the letter of the live region and violates its purpose. Deferring
preserves the information and the politeness together.

**Scope: local to `MachinesPage`, and lost on unmount** *(approved)*. If the
person navigates away while the reveal is open, `MachinesPage` unmounts and the
parked name goes with it. This is a decision rather than a limitation.
Announcing "Revoked work laptop." to someone now standing on `/settings`, with
no machines list in front of them, is disorienting rather than informative —
the announcement describes a screen they have left.

**Focus is unchanged.** The existing
`(rowRefs.current.get(machine.id) ?? statusRef.current)?.focus()` already
cannot move focus while the page is inert, and should not — focus belongs to
the dialog and `TokenReveal` restores it to the opener on dismissal.

**The mint guard is not the fix.** `MachinesPage.tsx:82` reads
`if (!trimmed || minting || revealed) return;`, which prevents a mint while a
reveal is open. It does not prevent this ordering: the revoke is already in
flight when the reveal opens, so nothing it guards has happened yet.
`onlooker-5o4` says as much.

### Why this is not generalized *(approved)*

The three other live regions in the app are left alone. `form.tsx:317` and
`LessonsPage.tsx:325` describe state on the page they live on, and a person
reading a one-time token is not waiting on either. No bead reports them, and
none of them has the property that makes the revoke case a defect: an
announcement whose triggering action completed, whose outcome is otherwise
unreported, and which is dropped silently.

Generalizing would mean an app-level announcer portaled outside `inert`, which
was considered and rejected. It fixes the class rather than the instance, but
it costs a new app-level concept and puts a machines-specific message into
`reveal.tsx`, a module that currently does one thing.

---

## Section 3 — Testing *(approved)*

**Section 1 is testable and the test is the point.** Assert the wrapper carries
`inert=""` while a reveal is open and drops it on dismissal, exercised on a
route that does not render `AppShell`. That assertion fails against `main`
today, which is what makes it worth writing — a test on `/machines` would pass
before and after and prove nothing.

**Section 2's deferral is testable.** That the region stays empty while
revealed and gains its text after dismissal is ordinary state, observable in
jsdom without depending on `inert` semantics at all.

**One thing is not testable here, stated plainly so it is not re-litigated.**
`onlooker-5o4`'s underlying claim — that `inert` removes the region from the
accessibility tree — cannot be verified in this suite. jsdom does not implement
`inert`. A test written against the old behavior would pass while reporting the
opposite of what the browser does, which is worse than no test: it would record
the bug as fixed.

That half is verified in a real browser and the observation recorded in the
bead. The test suite covers the deferral logic; the browser covers the premise
the deferral rests on. Neither is asked to do the other's job.

---

## Consequences

**`onlooker-zq1` closes.** Its proposed fix — "hoisting `inert` to something
that wraps every route" — is Section 1, and the residual its note identified is
covered exhaustively rather than partially.

**`onlooker-5o4` closes** on the browser verification, not on a green suite.

**`2026-08-29-machines-reveal-and-a11y-design.md` gains an amendment** pointing
here, recording that its Sections 3 and 4 were not independent. The claim is
left in place rather than edited: it was the reasoning at the time, and a spec
that quietly rewrites its own history teaches nothing to the next reader.
