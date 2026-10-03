# Shared Lesson Read Path And Moderation — Design

Bead: `onlooker-wi9ftq.1`, a spike under `onlooker-wi9ftq`
([ONL-12](https://linear.app/onlooker/issue/ONL-12), org visibility) and
blocking `onlooker-7x1khc`
([ONL-13](https://linear.app/onlooker/issue/ONL-13), public visibility).

Both tiers need the same three things: read authorization that does not key on
`user_id`, an explicit statement of how each route authenticates, and moderation
that acts on `author_key`. Specifying them once keeps ONL-13 from inventing a
read path that ONL-12 then has to conform to.

Three new endpoints (one anonymous read, two operator controls), one new column,
one new table, two new required fields on the route table. No change to the push
side, the sync protocol, or the lesson contract.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-27.
Sections marked *(measured)* were read from this repository or from
`onlooker-community/ecosystem` on 2026-09-27; each names the file and line the
fact came from, so a reader can check it rather than trust it.

## ONL-13's premise no longer holds *(measured)*

ONL-13's description requires that "only a human can assert that a lesson holds
for every version, and the jury has to be unanimous." Neither half survives
contact with what shipped:

- **The human-assertion half is reversed.**
  `ecosystem/plugins/librarian/docs/adr/004-a-model-may-assert-version-independence.md`
  (Accepted 2026-09-27) lets a model write the version-independence
  justification, held instead to a stricter `-auto` rubric and a veto window.
  `ecosystem/docs/superpowers/specs/2026-09-26-automatic-lesson-promotion-design.md`
  lists ONL-13 under "Supersedes, in part."
- **The unanimity half was never built.** The only consensus rule enforced
  anywhere is `agreed <= judges`, at `apps/api/src/lessons/rules.ts:78`. Nothing
  checks `agreed == judges`, and PR #387 gates the public rubric on score floors
  and a threshold rather than on unanimity.

Two of ONL-13's children have already landed in `ecosystem`: PR #384 (merged
2026-09-26, version-independent intake) and PR #387 (merged 2026-09-27, the
unattended pipeline). The intake spec states the boundary plainly — "it does not
specify the public tier's read path, moderation, or unanimity rule — those
remain ONL-13's."

**So whether the public tier requires unanimity is an open question for ONL-13
to settle, not a premise this design inherits.** This document does not answer
it. It builds the read path either answer needs.

## What a read authorizes against today *(measured)*

`user_id` is the security boundary on every lesson read, and deliberately so —
`apps/api/src/db/lessons.ts:325` says it "comes from the authenticated token and
never from the request - a caller cannot ask for someone else's stream, because
there is no parameter that would let them."

That boundary is enforced by **two different mechanisms**, which is the problem:

- `listLessonsPage` (`apps/api/src/db/lessons.ts:555`) filters in SQL, building
  `where = "user_id = ?"` as a string and appending further clauses to it.
- `getLessonForUser` (`apps/api/src/db/lessons.ts:628`) fetches unfiltered and
  compares `stored.user_id !== userId` in TypeScript afterward.

Two mechanisms means the next read path inherits whichever one its author read
first, and the TypeScript-side one cannot express org or public membership
without duplicating the predicate. Neither is wrong today; neither extends.

Three further facts shape everything below:

- **`author_key` is not a column.** The `lessons` table holds `id`, `user_id`,
  `visibility`, `status`, `schema_version`, `body`, `promoted_at`, `created_at`,
  `updated_at` — confirmed in `packages/db/src/schema.ts`,
  `packages/db/src/expected-schema.ts:50-108`, and every file in
  `packages/db/migrations/`. `author_key` exists only inside the `body` JSON, so
  nothing can filter on it. Yet
  `packages/lesson-contract/src/primitives.ts` describes it as "what org
  revocation and public blocking act on."
- **Auth is called inside each handler.** The `Route` interface
  (`apps/api/src/router.ts:42-54`) carries only `method`, `path`, and `handler`.
  Whether a route authenticates, and how, is invisible at the route table and
  discoverable only by reading the handler. A forgotten call is an open
  endpoint, and nothing would say so.
- **The `/api/` prefix is where the drift gate reaches.** `router.ts:157-162`
  records that a route outside it "cannot be mocked in development and cannot be
  reached by an api-contract case - which is how this surface, the one place in
  the product that mints a credential, spent three PRs as the only one outside
  the drift gate."

## Three read families, and only one gets a predicate *(approved)*

The distinction that keeps this design honest is **what a query enters
through**, not what it returns:

| Family | Entry point | Authorized by | Change |
|---|---|---|---|
| **Pool reads** | `FROM lessons` | the visibility predicate | move onto `readPool` |
| **Feed reads** | `FROM lesson_feed JOIN lessons` | the feed's own `user_id` key | unchanged |
| **Id probe** | `FROM lessons WHERE id IN (…)` | nothing, deliberately | renamed only |

**Feed reads stay as they are.** `readLessonDelta`
(`apps/api/src/db/lessons.ts:335`) and `listActivityPage` (`:456`) enter through
`lesson_feed`, whose unique index is `(user_id, seq)`
(`packages/db/src/schema.ts`). The feed only ever contains a user's own
lessons, so these answer "what changed in my stream" — not "what may I see in
the pool." Routing them through a visibility predicate would be wrong, not
merely unnecessary: it would imply the feed can carry a foreign lesson, which
is exactly the change this design defers.

**The id probe stays unauthorized, and gets a name that says so.**
`getLessonsByIds` (`:228`) must see lessons belonging to anyone: push decides
idempotency for a batch and "has to know that an id is taken even when it
belongs to someone else - while being careful never to reveal that fact." It is
renamed **`probeLessonIds`**, with a comment pinning that its results must never
be serialized into a response. A later reader who "fixes" it by adding a
`user_id` filter would silently break push idempotency, and the current name
invites exactly that.

**Pool reads get the chokepoint.** `listLessonsPage` and `getLessonForUser`
become thin callers of one function:

```ts
readPool(db, principal: Principal | null, filters): Promise<…>
```

Callers pass filters, never SQL. There is no other path from a route to a lesson
body. Forgetting the visibility predicate stops being a bug a test might catch
and becomes a thing that cannot be written.

## The predicate *(approved)*

A principal is what the router resolved from the route's declared `auth`, and
carries no more than the predicate needs:

```ts
type Principal = { userId: string }
```

Operator authority is deliberately absent from it. Moderation is authorized by
the route's `auth: "operator"` and acts through its own functions, so no read
predicate ever has an operator branch that could widen what a read returns.

One function inside `readPool`, the only place a visibility predicate is
constructed:

- **`principal === null`** → `visibility = 'public'`. Nothing else.
- **`principal = { userId }`** → `(user_id = ? OR visibility = 'public' OR
  user_id IN <org members>)`.

And ANDed onto both, always, the ownership-boundary rule:

> Your own lessons you see at any status. Across an ownership boundary, nothing
> retracted and nothing owned by a blocked `author_key` is ever served.

For a null principal every row is across an ownership boundary, so retraction
and blocking always apply to anonymous reads. That one sentence is what makes
both moderation controls take effect, and it lives where no read can skip it.

### The org hole fails closed

ONL-12 fills one resolver. This design states its contract rather than its
implementation:

```ts
// Returns the user_ids sharing an org with userId.
// Never includes a non-member. Never throws: an org that cannot be resolved
// returns [], so a membership outage narrows access instead of widening it.
type OrgMembers = (db: D1Database, userId: string) => Promise<string[]>
```

Until ONL-12 lands, the stub returns `[]`. **That means this whole seam ships
and goes live changing no observable behavior**, with its tests already in
place — an org read sees exactly what it sees today, because the org set is
empty. The same principle governs the blocklist lookup: if it cannot be read,
the read fails rather than serving unfiltered. Fail closed in both directions.

## The anonymous surface *(approved)*

`GET /api/public/lessons/:id`, no token, returns one public lesson. This is the
shareable-link half of a public gist: paste a lesson URL into Slack and someone
without an account can read it.

**Scope is one lesson by id.** Listing, search, and any index of the pool stay
behind the logged-in app. A public directory is a real product surface and
becomes its own issue once there is public content worth indexing; shipping it
now would mean a scrapeable index from day one whose cost is bounded by nothing
the reader has to possess.

**It lives inside `/api/`** despite being unauthenticated, because outside that
prefix it could be neither mocked nor reached by an api-contract case
(`router.ts:157-162`). The `public` path segment is the marker for a human;
`auth: "none"` is the marker for a machine.

**It gets its own handler**, which can only ever call `readPool` with a null
principal. A predicate bug on an anonymous route leaks to the internet rather
than to one logged-in user, so there must be no code path where a
caller-supplied value could widen what it sees.

**404, never 403.** A private or org lesson requested anonymously is
indistinguishable from one that does not exist. A 403 would confirm the id. This
matches what the codebase already does deliberately: `getLessonForUser` returns
null, and `transitionLesson`'s comment says the caller "cannot tell those apart,
which keeps the route from confirming that another user's lesson id exists."

**The cache TTL is the floor on takedown latency.** An anonymous read is
cacheable at the edge, and a cached public lesson keeps being served after it is
retracted. Since a fast pull is the control the whole moderation story rests on,
the ceiling is 60 seconds, or no edge cache with a purge on retract. This is
stated as a relationship rather than a number so it cannot be tuned without
noticing what it costs.

**Rate limiting has no principal to key on.** It belongs in Cloudflare's
edge rate-limiting rules, keyed on IP, configured outside the worker — not in
application code that would have to invent a request identity.

## Route auth becomes declarative *(approved)*

`Route` gains two required fields:

```ts
auth: "none" | "session" | "machine" | "session-or-machine" | "operator"
cors: "app" | "any"
```

The router resolves the principal centrally from `auth` and hands it to the
handler; handlers stop calling auth themselves. Because `auth` is required, a
new route **cannot compile** without the author choosing.

`"none"` stays expressible — login, signup, password reset and email
verification need it — but a contract test pins the exact set of `auth: "none"`
routes. An unauthenticated endpoint becomes an edit to an enumerated list
somebody reviews, rather than a function call somebody forgot.

**`cors` is a separate field, not derived from `auth`.** `auth: "none"` cannot
drive the wildcard exception, because login and signup are also `auth: "none"`
and must stay locked to one origin: `apps/api/src/middleware/cors.ts` exists
because a hostile page reading those responses "is what made credential
stuffing from arbitrary origins cheap." Only a route that accepts no
credentials *and* returns solely public data gets `cors: "any"`. A second
contract test pins that set too.

## Moderation *(approved)*

Two operator controls, both server-side, on routes declaring `auth: "operator"`:

- **Retract any lesson, regardless of owner.** `transitionLesson`'s existing
  `WHERE id = ? AND user_id = ?` stays exactly as the user-facing path. The
  operator path is a **separate function**, so a cross-owner write cannot happen
  by passing the wrong argument to the ordinary one.
- **Block an `author_key`**, so nothing it owns is served to anyone.

Reports arrive out of band, by email. That is a documented channel, not a built
one — an in-product report queue is a moderation subsystem, and premature while
the pool holds no public lessons at all.

### Why `author_key` is the right handle

`primitives.ts` already explains it: the key is "derived per visibility scope
from the author's secret; not linkable across scopes," and is deliberately 128
bits rather than `project_key`'s 48 "because `author_key` is what org revocation
and public blocking act on, so a collision would block an innocent author
alongside a bad actor." Blocking is the use this field was designed for. It also
means a public lesson's key is a *public-scope* key: exposing it anonymously
reveals nothing about the author's org or private identity.

### The migration

`author_key` lifts out of `body` into an indexed column, matching the schema's
own stated rule that "only the fields the server filters or orders on are lifted
into columns" (`packages/db/src/schema.ts:161`).

It hits the same SQLite constraint `promoted_at` already documents — `ADD COLUMN
... NOT NULL` is refused without a non-NULL default, "true even for an empty
table" — so it lands with a `''` default and a backfill of existing rows via
`json_extract(body, '$.author_key')`. `packages/db/src/expected-schema.ts` is
updated in the same change so the drift check stays honest.

A blocklist table keyed on `author_key` holds the blocks, with the reason and
the acting operator recorded.

## Tests *(approved)*

**Leak tests, parameterized over every tier below public.** For `private` and
for `org`, an anonymous `GET /api/public/lessons/:id` returns 404.

**Each leak test must be proven by ablation.** Delete the predicate, watch the
test fail, restore it. A leak test passes trivially when the fixture happens to
contain no private lessons, so a guard that has never been observed to fail is
not evidence that it guards anything. The ablation is part of the task, not an
optional check.

Beyond that:

- A public lesson is readable anonymously, and equals what its owner sees.
- A blocked `author_key`'s public lesson: 404 anonymously, and absent from an
  authenticated browse.
- A retracted public lesson: 404 to a foreign reader, still visible to its
  owner.
- With the org stub returning `[]`, every existing lessons and activity test
  passes unchanged. This is the evidence that the seam ships inert.
- Route table contract tests: every route declares `auth`; the `auth: "none"`
  set equals its expected list; the `cors: "any"` set equals its expected list.
- `probeLessonIds` still spans owners, so push idempotency across users is
  pinned by a test that fails if a `user_id` filter is ever added.

Three gates, per this repo's CI: `vitest`, `tsc --noEmit`, and the per-package
`biome` lint.

## Boundary changes to sibling issues

- **ONL-12** fills `OrgMembers` and specs org creation, membership and roles
  against the contract above. It writes no new read machinery.
- **ONL-13** answers unanimity, and the abuse boundaries specific to content
  leaving the author's own org. Its read path is this document's.
- **Neither** opens the push gate. `apps/api/src/routes/lessons.ts:104` keeps
  rejecting non-private lessons, pinned by `routes/lessons.test.ts:184`, until
  both tiers have landed — nothing should enter the pool at a tier whose read
  path is still being built. Opening it is the last step.

  > **Status, 2026-10-03.** Half done, and deliberately so. The gate now
  > admits `public`; `org` still does not. The rule above said to wait for
  > *both* tiers, and the reason it gave — nothing should enter the pool at a
  > tier whose read path is still being built — turns out to split cleanly by
  > tier rather than binding them together. Public's read path is built,
  > shipped and verified in production. Org's is still the inert `OrgMembers`
  > stub, and admitting org lessons against it would be worse than merely
  > early: they would read as private now and become org-visible
  > *retroactively* when the resolver lands, which is a disclosure their
  > authors never consented to. So org waits on ONL-12 and ships in the same
  > change as its resolver. Public additionally requires a unanimous jury at
  > ingest, which is ONL-13's open unanimity question settled conservatively;
  > see `onlooker-7x1khc.1`.

## Deferred, each to its own issue

- **Foreign lessons entering the CLI's local mirror.** Until this lands, local
  always-on retrieval matches only your own lessons, which leaves the Shared
  Playbooks story incomplete on the client. `packages/db/src/schema.ts:169`
  anticipates the eventual shape — "matching happens on the client against its
  mirror, which leaves visibility as the only server-side filter" — but the
  delta protocol's per-user `(user_id, seq)` key has no room for a lesson
  somebody else owns, so this needs its own design.
- **Anonymous listing or search of the public pool**, and the public directory
  that implies.
- **Reader-side mute of an `author_key`**, the only moderation control that
  scales without operator bandwidth.
- **An in-product report path.**
- **Whether a public reader can tell a model-asserted lesson from a
  human-asserted one.** `ZLesson` is a `strictObject`
  (`packages/lesson-contract/src/lesson.ts:48`) and PR #387 deliberately kept
  `asserted_by` on the proposal envelope rather than the pool entry, so
  surfacing it would be a `schema_version: 3` change. ONL-13's call.

## Out of scope

- Any change to push, the jury, the rubrics, or promotion.
- Any change to the lesson contract or its `schema_version`.
- Org membership itself — the resolver's contract is here, its implementation is
  ONL-12's.
