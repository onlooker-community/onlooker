# Lesson Pool Surface — Design

**Status:** Approved. PRs 1-3 shipped; amended 2026-08-25 (see Amendments)
**Date:** 2026-08-23
**Epic:** `onlooker-bmp`
**Depends on:** [sync endpoint and hosted pool](2026-08-22-sync-endpoint-hosted-pool-design.md)

## Reading this document

Sections record what was decided and, where an alternative was rejected, why —
so the rejected option is not rediscovered as a fresh idea in three months.
Several of the rejections below are the intuitive answer, which is exactly why
they are written down rather than left implied.

---

## Boundary

The sync spec ends at a protocol: a machine credential, a hosted pool, push and
delta read. It delivers "a lesson promoted on one machine appears on another."
It says nothing about a person, because nothing in it involves one.

```
          ... push to pool          shipped, #70
             └→ hosted pool         shipped, #70
                └→ delta pull       shipped, #70
                   ══════════════════════════════════════
                   └→ mint a credential   NEW  Section 2
                      └→ read the pool    NEW  Sections 1, 3
                         └→ judge one     NEW  Section 3
                            └→ correct it NEW  Section 4
```

**The gap this closes is not cosmetic.** `POST /machines` is
browser-authenticated by design — a machine token that could mint another would
make revocation meaningless, since revoking the stolen laptop would not reach
the credentials it had already issued for itself. That design is right, and
nothing in the browser calls it. **No user can obtain a machine token**, so the
sync protocol that shipped cannot be turned on by anyone.

**In scope:** browser-authenticated read of the pool; a two-pane read/judge
surface; human retraction; machine token management; deletion of the placeholder
dashboard.

**Out of scope, each for a stated reason:**

| Deferred | Why |
|---|---|
| Stack filtering | `applies_to.stack` is an array inside the JSON body; needs `json_each` and a derived index. `onlooker-4bw` |
| `refuted` from the browser | Belongs to the counter-observation path that produces it, which is out of scope in the pipeline spec |
| `superseded` from the browser | Needs a replacement lesson, and the browser has no authoring — the pipeline writes lessons |
| Lesson authoring | Lessons come from the promotion pipeline. A hand-written lesson has faced no tribunal |
| `org` / `public` visibility surfaces | No org model exists; `public` needs the server-side re-judge. Both deferred in the sync spec |
| Heartbeat coverage of the new read | Kept out of the API PR to hold it to one concern. `onlooker-mkp` |

**What it delivers:** the pool becomes legible, and a human gains an off-switch.

---

## Section 0 — What is already true *(context, not decisions)*

Facts the design rests on. Each was checked against the code, and each has
changed the design at least once.

- A lesson is stored as **a JSON blob in `lessons.body`**. Only `visibility`,
  `status` and `schema_version` are columns; `claim`, `promoted_at` and
  `applies_to` are not. The only index is `lessons_user_id_idx`.
- `lesson_feed` is append-only and carries ordering, not state. A transition
  appends a row rather than moving one, which is what keeps mirrors' contiguity
  check from firing on every legitimate status change.
- `apiClient` already owns transport: `Authorization` injection, backoff retry,
  and one refresh-and-replay on 401. `useAuthenticatedFetch` owns only the React
  lifecycle. Neither is re-implemented here.
- `form.tsx` holds a `PALETTE` whose plate/accent distinction is load-bearing —
  using a plate as text once put links at 1.35 contrast in day mode.
- `playwright.config.ts` points `testDir` at `apps/website/playwright`, which
  does not exist, and no `*.spec.ts` exists anywhere in the repo. Testing for
  `apps/web` is vitest and testing-library.

---

## Section 1 — Surfaces *(approved)*

| Route | Auth | What it is |
|---|---|---|
| `/lessons` | session | The pool. List pane only on narrow screens. |
| `/lessons/:id` | session | Two-pane on wide: list left, detail right. Detail only on narrow. |
| `/machines` | session | Mint, list, revoke machine tokens. |
| `/settings`, `/profile` | session | Unchanged. |
| `/dashboard` | — | **Deleted.** `RequireAuth` lands on `/lessons`. |

### The two panes are routes, not state

`/lessons/:id` renders the detail. Making the selection component state instead
would cost the back button, deep links, and any ability to paste someone a
lesson. It also means narrow screens need **one breakpoint** — list-only at
`/lessons`, detail-only at `/lessons/:id` — rather than a second layout.

### Deleting the dashboard

`/dashboard` serves `totalSessions`, `activeProjects` and
`unreadNotifications`: three numbers invented for a scaffold, none of which the
product has. It exists in five places — `handleGetDashboard`, two `api-contract`
cases, the `mockApi.ts` branch, `DashboardData`, and `DashboardPage.tsx`.

It is also the endpoint at the center of the blank-dashboard incident that
`packages/api-contract` was created to prevent. Keeping it means maintaining
agreement between a mock and an API about data nobody reads. Deleting it removes
a drift surface rather than adding one.

**Rejected:** rewriting it against real counts. It would need a fourth endpoint
and its own contract cases to duplicate what `/lessons` and `/machines`
already show on the page the user is already looking at.

**Rejected:** turning it into a conditional setup surface that redirects once a
machine has pushed. Two states, each needing tests, to replace what an empty
state says in one sentence.

---

## Section 2 — The machine credential, from a browser *(approved)*

Three endpoints already exist and are already browser-authenticated. This
section is a UI over them, with one constraint that dictates the whole design.

### The reveal is the only chance, so it is built like it

`handleCreateMachine` returns the raw token in the create response **and nowhere
else, ever** — only its SHA-256 is stored. Therefore:

- The token appears in a panel with a copy button and a plain statement that it
  will not be shown again.
- It is dismissed by an explicit "I've saved it." Not a timeout, not a click
  elsewhere. Navigating away with it open asks first. *(Amended 2026-08-25: the
  reveal is a focus-trapping modal, so there is no in-app navigation left to
  intercept. See Amendments.)*
- Recovery is revoke-and-mint-again, and the empty state says so rather than
  leaving the user to discover it.

### "Never used" is a state, not a blank cell

The list shows `name`, `created_at` and `last_used_at`. Minting a token and
never pointing a plugin at it is the most likely first-run failure in the whole
product, and a dash in a column does not say that. It gets its own treatment.

`last_used_at` is also the sync-health signal the surface was asked for: which
machines are pushing, and when each last did.

### Revocation

Irreversible, so it confirms inline through `ui.tsx` rather than
`window.confirm` — the app should not hand its most destructive action to a
native dialog that looks like nothing else in it.

---

## Section 3 — Reading and judging the pool *(approved)*

### Why the browser gets its own routes

`GET /lessons` is machine-authenticated and delta-shaped: a sequence cursor,
every status included, built for a mirror draining a queue. Browsing is the
opposite read — newest first, filtered, paginated. `PATCH /lessons/:id/status`
is machine-only.

Three new `requireAuth` routes, scoped to the caller's `user_id`:

| Route | Behavior |
|---|---|
| `GET /api/lessons` | Newest first, cursor paginated. `?status` repeatable, `limit` default 50, max 200. Returns full bodies. |
| `GET /api/lessons/:id` | One lesson. Exists so a deep link outside the first page resolves. |
| `PATCH /api/lessons/:id/status` | `active` and `retracted` only. See Section 4. |

**Rejected: dual-authenticating the existing routes.** Every handler would
branch on credential kind, and the delta contract would grow browsing concerns —
precisely the shared-surface failure the `sessions` / `machine_tokens` split was
created to avoid. Keeping them separate means a browsing change cannot break a
mirror mid-drain.

**Known cost, accepted:** `/lessons` and `/api/lessons` differ by a prefix and do
different things. Naming the browser read `/api/pool` was considered and
rejected for introducing a second name for one concept.

### The list returns full lessons, not summaries

A lesson is roughly 1KB. Returning full bodies means the detail pane renders
from the list already in memory, so clicking down the left column issues no
requests at all. `GET /api/lessons/:id` is the fallback for the one case that
cannot work that way — an id not in the loaded pages.

### One migration: `promoted_at` becomes a column

Ordering newest-first over a field inside the JSON blob would mean
`json_extract` on every row with no index to sort against. The tempting
workaround — order by `created_at`, which is a real column — is wrong in a way
that shows: the list *displays* `promoted_at`, so the first time a machine syncs
a backlog the dates appear visibly out of order.

So `promoted_at` becomes a column with an index on `(user_id, promoted_at)`. It
is immutable and set at ingest, so it cannot disagree with the body.
`expected-schema.ts` is updated in the same PR — the deploy verifies deployed
schema against source, so skipping it fails the deploy rather than the tests.

### Stack filtering is deferred, not shrunk

Filtering client-side is not a smaller version of stack filtering. It filters one
loaded page and calls it the pool, which is wrong the moment pagination exists.
Status filtering ships because `status` is a real column. `onlooker-4bw`.

---

## Section 4 — Correcting the pool *(approved)*

**A human may set `retracted`, and may set it back to `active`. Nothing else.**

The endpoint accepts all four statuses for machines. The browser route accepts
two, and rejects the others with a 400 naming why:

- `refuted` means a claim was tried and found false. It belongs to the
  counter-observation path that produces it. A click is not evidence.
- `superseded` must name the lesson that replaced it, and the browser has no
  authoring — the human would be asserting a relationship the tribunal never
  judged.

This is enforced **server-side**, not by which buttons the UI renders. A rule
that lives only in the client is not a rule.

### Retraction reaches every machine for free

The browser route calls the same `transitionLesson` the machine route does,
which appends to `lesson_feed`. A retraction made on the web therefore
propagates to every mirror on its next delta pull, with no new sync machinery.
The human off-switch is global by construction.

### It does not update optimistically

Retract round-trips, shows pending, and reflects what the server said. A UI that
shows a lesson retracted when it is not is worse than a slow button — the whole
point of the action is to stop trusting a claim.

One failure is surfaced specifically: `transitionLesson` can throw
`SequenceExhaustedError`, which the API turns into a 503 `sequence_contention`
whose message says *nothing was written, so retry*. The API went out of its way
to distinguish that from a real failure; flattening it into "something went
wrong" would discard the distinction at the last step.

---

## Section 5 — Web structure *(approved)*

**New files:**

| File | What it holds |
|---|---|
| `components/AppShell.tsx` | Persistent nav wrapping authenticated routes |
| `components/palette.ts` | `PALETTE`, lifted from `form.tsx` unchanged |
| `components/ui.tsx` | `StatusBadge`, `Chip`, `Panel`, `EmptyState`, `Button` |
| `api/lessonsApi.ts`, `api/machinesApi.ts` | Beside `accountApi.ts`, same shape |
| `pages/LessonsPage.tsx`, `pages/LessonDetail.tsx`, `pages/MachinesPage.tsx` | The surfaces |

**The one refactor.** `PALETTE` moves out of `form.tsx` and both files import it.
This is not cleanup for its own sake: the alternative is a second palette in the
new components that re-derives the plate/accent distinction and gets it subtly
wrong. That distinction already cost a 1.35-contrast bug. `form.tsx` keeps the
form primitives; `ui.tsx` takes the display ones. The auth pages are not
rewritten.

**Data flow.** `/lessons` is a layout route that fetches one page. `/lessons/:id`
renders from that in-memory list, falling back to `GET /api/lessons/:id` when the
id is not present.

---

## Section 6 — Empty states and failure *(approved)*

The dominant state at launch is empty, so it is designed rather than defaulted.

| State | What it says |
|---|---|
| Pool empty | Nothing has synced yet — with a link to Machines |
| Filter matches nothing | "No retracted lessons" |
| Fetch failed | The error-and-Retry `DashboardPage` already has, moved into `EmptyState` |

The second row is the one that matters. An empty filter result that said
"connect a machine" would be a lie told to someone whose pool is full.

**Rejected:** detecting "token minted but never used" on the lessons page. It
would make the pool page fetch machines to explain itself, and the machines page
already diagnoses it better in the place where it can be fixed.

---

## Section 7 — Testing *(approved)*

- **`api-contract` cases for all three routes.** This is the gate, not a
  nicety — it is what makes the mock and the real API fail together instead of
  drifting apart a third time.
- **API:** another user's lesson returns **404, not 403** — a 403 confirms it
  exists. `refuted` and `superseded` rejected with 400. Cursor pagination stable
  across a concurrent insert.
- **Migration:** `expected-schema.ts` updated in the same PR; the existing
  verify-schema test covers the rest.
- **Web:** detail renders from memory on click and fetches on deep link; the
  reveal is not dismissable by accident; a failed retract leaves the row
  untouched; empty pool and empty filter render different states.

---

## Section 8 — Sequencing *(approved)*

Five PRs, each independently deployable, one cutover.

| # | Bead | What lands | Visible? |
|---|---|---|---|
| 1 | `onlooker-w5o` | `promoted_at` column, index, `expected-schema.ts` | No |
| 2 | `onlooker-yj5` | Three browser routes, contract cases, mock branches | No |
| 3 | `onlooker-j2u` | `palette.ts`, `ui.tsx`, `AppShell` | No |
| 4 | `onlooker-k7w` | Machines page and the one-time reveal | Yes |
| 5 | `onlooker-yfw` | Lessons two-pane, retract, **and the dashboard deletion** | Yes |

**Why the deletion rides with the lessons PR.** Removing `/dashboard` before
`/lessons` exists lands `RequireAuth` on a route that isn't there. They ship
together so the landing route always exists. That pairing is why swapping 4 and
5 was safe: the machines page carries no part of the cutover.

Follow-ups, filed rather than absorbed: `onlooker-4bw` (stack filtering),
`onlooker-mkp` (heartbeat coverage).

---

## Open questions

**Does `promoted_at` need a backfill, or is the pool small enough to rebuild?**
The migration assumes backfill from `body`. With one deployed user and a pool
measured in tens of rows, either works; backfill is written because it is the
one that stays correct if that stops being true before the migration runs.

**Is `limit` 50 the right default?** Chosen to fill the list pane roughly twice
over without a scroll-to-load on first paint. Untested against a real pool,
because no real pool exists yet.

---

## Amendments

### 2026-08-25 — reconciling with what shipped

PRs 1-3 shipped as written. Building the machines page next surfaced four
things this document got wrong or could not have known. Recorded here rather
than edited silently, because three of them are decisions and not typos.

**The machines route is `/machines`, not `/settings/machines`.** `AppShell`
shipped in PR 3 with a four-item top-level nav and a test pinning the href.
Machines is a section, not a preference: it is where a credential is minted and
revoked, which is not the same kind of act as changing a display name. The route
table above is corrected.

**The API moves under `/api/`.** The three handlers were registered at
`/machines`, outside the prefix every other browser-authenticated route uses.
That is not only untidy. `createMockFetch` claims `/auth/*` and `/api/*` and
passes everything else to the network, so a call to `/machines` in development
reaches the Vite dev server; and no `api-contract` case covered the surface at
all. The one surface in the product that mints credentials was the one outside
the drift gate that exists because of the blanked dashboard. Moving it costs a
rename nothing calls yet — no browser could mint a token, so no machine token
exists in production to break.

**The reveal is a modal, not a navigation block.** This document said navigating
away with the token open "asks first," which reads as `useBlocker`. `main.tsx`
mounts `BrowserRouter`, where `useBlocker` throws; it needs a data router, and
migrating every route to `createBrowserRouter` is not this PR. A focus-trapping
modal reaches most of that requirement directly: with the nav behind it and
unreachable there is no in-app link left to follow away from the page, and
`beforeunload` covers reload, tab close, and a Back that leaves the document
entirely. The binding requirement was never the dialog — it was that nothing
dismisses the token except an explicit act.

What neither reaches is a same-document Back: React Router handles a
`popstate` client-side, which unmounts the page mid-reveal with no
`beforeunload` in between, discarding an unsaved token that is recoverable
only by revoking the machine and minting another. A history-sentinel guard
was built and reverted during the 2026-08-25 fix wave - it broke Back
navigation for the rest of the session for everyone who visited the page, a
worse failure than the one it closed. `onlooker-1bz` records why and tracks
closing the gap for real.

**PRs 4 and 5 are swapped.** Machines ships first. Nothing can reach the pool
until someone can mint a credential, so the lessons page would otherwise ship
against a pool that is empty by construction, and its empty state links to a
Machines route that would not exist. The cost is that `AppShell`'s Lessons link
renders the 404 page for one PR, and that `/machines` needs a temporary link
from `DashboardPage`'s nav to be reachable — deleted with that page in PR 5.
