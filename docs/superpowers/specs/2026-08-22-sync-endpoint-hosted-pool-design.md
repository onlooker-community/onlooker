# Sync Endpoint and Hosted Pool — Design

**Bead:** `onlooker-cwj` — subsystem 3 of Shared Playbooks, from the `onlooker-66u` lineage
**Depends on:** [lesson contract](2026-08-06-shared-lesson-contract-design.md),
[promotion pipeline](2026-08-08-promotion-pipeline-design.md)

## Reading this document

Sections are marked *(approved)* once settled. Each records what was decided
and, where an alternative was rejected, why — so the rejected option is not
rediscovered as a fresh idea in three months.

Two decisions in here were **corrected mid-design** rather than settled on the
first pass. Both corrections are kept in the text, because in both cases the
first answer is the intuitive one and will be proposed again by anyone who has
not seen why it fails.

---

## Boundary

This picks up exactly where the promotion pipeline stops. That spec ends at a
local approved pool and says it deliberately leaves subsystem 3 "a queue to
drain rather than a protocol to negotiate." This is the drain.

```
          ... tribunal gate            plugin repo, spec'd
             └→ approved pool          plugin repo, spec'd
                ═══════════════════════════════════════════
                └→ machine credential  NEW  Section 1
                   └→ push to pool     NEW  Section 3
                      └→ hosted pool   NEW  Section 2
                         └→ delta pull NEW  Section 4
                            └→ local mirror   plugin repo, later
```

**In scope:** a non-interactive machine credential; the pool's schema, ingest,
and delta read; `private` visibility writable.

**Out of scope, each for a stated reason:**

| Deferred | Why |
|---|---|
| `org` tier | No org model exists anywhere in `packages/db` or `apps/api` — orgs, membership and admin roles are a subsystem of their own |
| `public` tier | Needs the server-side re-judge with the disclosure lens from contract spec Section 3 |
| Counter-observations, re-judgment | Already out of scope in the pipeline spec, and the counter-observation threshold is still an open number |
| Waypoint deep query | The tiered retrieval engine is a separate subsystem |
| `author_key` forgery | Has no teeth until `org` or `public` exists — see [Open questions](#open-questions) |

**What it delivers:** a lesson promoted on one machine appears on another.
Cross-*machine*, not yet cross-*person*.

That distinction is worth stating plainly, because the settled product context
says the hosted app exists for cross-person sharing — "the only capability
impossible local-first." This subsystem does not deliver that. It builds the
protocol and the storage that cross-person sharing runs on, and per contract
spec decision 5 the pool holds all three visibilities from the start, so the
later tiers are a gate change rather than a data migration.

---

## Section 1 — The machine credential *(approved)*

Nothing that is not a browser can authenticate today. Auth is email/password to
a 15-minute JWT with a 30-day rotating refresh token in `sessions`. The thing
that syncs is a shell-based plugin on a laptop, and a plugin holding the account
password on every machine is not a design — that password also gates
`PATCH /auth/profile` and `DELETE /auth/account`.

### A new table, not an extension of `sessions`

```
machine_tokens
  id            TEXT PRIMARY KEY
  user_id       TEXT NOT NULL      FK users, cascade delete
  name          TEXT NOT NULL      human label, "work laptop"
  token_hash    TEXT NOT NULL      SHA-256; the raw value is never stored
  created_at    TEXT NOT NULL
  last_used_at  TEXT
  revoked_at    TEXT

  UNIQUE (token_hash)
```

`sessions` and `machine_tokens` look similar and behave differently. A session
is short-lived, rotating, and obtained by posting a password. A machine token is
long-lived, non-rotating, and never sees one. Sharing a table would mean every
query on it first has to establish which kind of row it is holding, and the
`revokeAllSessionsForUserExcept` path would silently start reaching credentials
it was never written for.

### Format and generation

`onlk_` followed by 64 hex characters — 32 bytes from
**`crypto.getRandomValues`**.

The prefix is not decoration. It makes the value recognizable in a paste and
greppable by secret scanners, which is what gets a leaked credential noticed.

The generation source is deliberately specified, because this repository
currently contains both a correct and an incorrect precedent for exactly this:

| Precedent | Source | Verdict |
|---|---|---|
| `createVerificationToken`, `queries.ts:341` | `crypto.getRandomValues(new Uint8Array(32))` | **follow this** |
| `generateRefreshToken`, `crypto.ts:65` | `Math.random()` in a loop | do not — see `onlooker-axo` |

`Math.random()` is not a CSPRNG. `onlooker-axo` (P1) tracks fixing the existing
use; this design must not add a third convention or copy the wrong one.

### SHA-256 at rest, not bcrypt

The token is a 256-bit random value, not a password. There is no dictionary to
slow an attacker down, so the work factor buys nothing — and bcrypt on every
sync request would burn Worker CPU on every call. `sessions` and
`verification_tokens` already hash bearer tokens with SHA-256; this follows them.

Verification is a single indexed lookup on the SHA-256 of the presented token.

### Revocation is per row

Revoking a lost laptop must not sign the other machines out. `revoked_at` is set
on one row; every other machine keeps working.

`last_used_at` exists so an unrecognized machine is *visible*. A revocation
control nobody can act on because they cannot tell which row is the stolen
laptop is a control in name only.

---

## Section 2 — The pool *(approved)*

### Storage: JSON body, plus only what the server filters on

```
lessons
  id              TEXT PRIMARY KEY   ULID, minted by the client
  user_id         TEXT NOT NULL      FK users, cascade delete
  visibility      TEXT NOT NULL      private | org | public
  status          TEXT NOT NULL      active | refuted | superseded | retracted
  schema_version  INTEGER NOT NULL
  body            TEXT NOT NULL      the validated lesson, JSON
  created_at      TEXT NOT NULL
  updated_at      TEXT NOT NULL
```

Only fields the server filters or orders on are lifted into columns. Everything
else stays in `body` as the contract's own JSON.

This is version-tolerant by construction: a future `schema_version` stores
without a migration, because the server never reads the fields that changed.

**The server never matches `applies_to`, and that is what makes this shape
correct rather than merely convenient.** `scope.versions` holds comparator
strings — `">=4 <6"` — pinned by `VERSION_RANGE`. Deciding whether one matches a
session on `vite@5.2.1` is a semver comparison, and D1 has no such function.
Decomposing every range into numeric bound columns and AND-ing across a join
table is possible and would still not answer the question without semver in SQL.

With a local mirror the server does not need to. It answers "everything since
your cursor that you are entitled to," and the client matches against its own
copy. The only server-side filter is visibility, which contract spec Section 3
already designates as the security boundary.

Rejected: full normalization (six tables, a migration per contract bump, and it
still cannot compare versions) and a `lesson_stack` join table to narrow deltas
server-side (an optimization for a pool large enough to need it, which does not
exist).

### The feed is separate from the state — *(corrected)*

The first version of this section put a dense monotonic `seq` column on
`lessons` and bumped it on every write, so mirrors would notice changes.

**That is wrong, and the reason generalizes: a dense sequence and mutable row
positions are incompatible.** If lesson X sits at `seq 5` and a retraction bumps
it to `seq 12`, position 5 is vacated. The client's contiguity check then sees a
hole and correctly reports corruption — so the mechanism that exists to detect
lost lessons fires on every legitimate status change.

Rows must therefore stop moving. The feed is split from the state:

```
lesson_feed                append-only; rows are never updated
  seq        INTEGER NOT NULL   dense per user
  user_id    TEXT NOT NULL
  lesson_id  TEXT NOT NULL
  kind       TEXT NOT NULL      create | status
  at         TEXT NOT NULL

  UNIQUE (user_id, seq)
  INDEX  (user_id, seq)
```

A create inserts state and appends a feed row. A transition updates state and
appends a feed row. Nothing in the feed is ever rewritten, so it is dense by
construction.

Reads do not fold an event log — they join the feed window to current state. A
lesson changed twice appears twice in one window, which is harmless: the client
upserts by `id` and the later entry wins.

This is deliberately *not* the append-only event log rejected during
brainstorming. Current state is a plain row, read directly. The feed carries
ordering only.

### `seq` is dense per user, not global — *(corrected)*

The first version made `seq` globally monotonic. That also fails, more quietly:
a user only ever reads their own rows, so a global counter leaves their stream
full of holes wherever any other user wrote. The contiguity check — the entire
reason for choosing a dense sequence — would fire constantly and mean nothing.

Assignment is `MAX(seq) + 1` **over `lesson_feed` for that user**, computed
inside the write transaction that appends the row.

A batch is assigned sequentially inside one transaction, and **a conflict
retries the whole batch, not the failing row**. Retrying one row would let a
concurrent push interleave into the middle of a batch, which is legal but makes
the failure harder to reason about than re-running an idempotent operation.
Retry is bounded; exhausting it is a 503, never a partial write.

**`UNIQUE (user_id, seq)` is what makes the counter correct.** If two pushes for
one user race and both compute 6, the second violates the constraint and
retries. Correctness therefore rests on a declared database constraint, not on
D1 committing in `seq` order — which was the specific objection to relying on
serialized writes. A rolled-back write consumes no number, so the sequence stays
dense.

**This does not generalize to `org` or `public`, and that is a real cost.** A
feed filtered across many authors cannot be dense, so those tiers need a
different cursor mechanism. That problem is handed to the org and public specs
explicitly rather than being discovered there.

---

## Section 3 — Ingest *(approved)*

### Validation order

1. **Authenticate.** Resolve the bearer token to a `user_id`. A revoked or
   unknown token is a 401 before anything is parsed.
2. **Parse with `ZLesson`.** `apps/api` *can* import
   `packages/lesson-contract` — the repo boundary that forces JSON Schema onto
   the plugins does not apply to the server — so the whole structural contract
   comes for free.
3. **Cross-field rules.** Below.
4. **Authority rules.** Below.

### The three cross-field rules

JSON Schema cannot express a constraint spanning two fields, so these are
deliberately absent from `packages/lesson-contract` and delegated here. Each is
documented as prose in a `.describe()` so it reaches the published artifact that
the plugins validate against.

| Rule | Delegated from |
|---|---|
| `consensus.agreed <= consensus.judges` | `ZConsensus`, `lesson.ts` |
| every key of `scope.versions` names an entry in `stack` | `ZAppliesTo`, `applies-to.ts` |
| a two-sided range is not inverted — `">6 <2"` | `VERSION_RANGE`, `primitives.ts` |

The promotion pipeline spec's table lists only the first two. The third is
delegated from a comment in `primitives.ts`, which states that rejecting `">6
<2"` "means comparing magnitudes, which a regex cannot do… That check belongs
with the other cross-field rules in server-side ingest." This is that ingest.

The second rule matters more than it looks. A `versions` key naming something
absent from `stack` means the lesson either never matches or the constraint is
silently skipped — and skipping it yields a lesson that never expires, which is
the failure class the `scope` union exists to close, reached by another route.

### Authority rules

**`visibility` must be `private`.** `org` and `public` are rejected with an
explicit message saying the tier is not open yet. A generic validation failure
would read as a client bug when the tier eventually lands.

**`superseded_by` is non-null only when `status` is `superseded`.**

**`author_key` is stored, never verified.** This is safe *here* and only here,
because retrieval filters on `user_id` from the authenticated token, so nothing
in this subsystem depends on the field being authentic. It is carried through
for the tiers where it becomes load-bearing — and unverifiable. See
[Open questions](#open-questions).

### Create and transition are separate routes

```
POST /lessons              create only, batch
  → { lessons: [Lesson, ...] }
  ← { results: [{ id, outcome, seq?, error? }, ...] }
     outcome: created | noop | conflict | invalid

POST /lessons/:id/status   { status, superseded_by }
  ← { id, seq }
```

The request is an object with a `lessons` array rather than a bare array, so a
later field — a client-supplied batch id, say — does not force a breaking shape
change. `seq` is returned on every write so a client can advance its cursor
without a follow-up read.

Content is immutable; lifecycle is not. `status` moves to `refuted`,
`superseded` or `retracted`, and `superseded_by` goes from null to a ULID.
Everything else — `claim`, `rationale`, `evidence`, `applies_to` — never
changes, because supersession mints a *new* lesson and links to it.

Splitting the routes keeps the mutable surface at exactly two fields in one
place. The rejected alternative, a single idempotent upsert, would make the
server diff every field on every push to tell a legal status change from an
illegal claim rewrite — and that comparison would run on the hot path of every
mirror re-push, where a field missed from the comparison is a silent
content-rewrite hole.

### Idempotency

A mirror will re-encounter lessons it already holds constantly, so this path is
hot, not rare.

- Same `id`, same content → **200, no-op, no feed row.**
- Same `id`, different content → **409** naming the field that differs.

**Comparison is over canonicalized JSON, not the raw string.** A lesson pulled
from the pool and re-pushed will legitimately differ in key ordering; comparing
bytes would turn every re-push into a spurious 409.

**The 409 must not become an existence oracle.** `id` is a global primary key,
so a push colliding with another user's lesson would otherwise confirm that ULID
is taken. ULIDs are unguessable, so the leak is small — and closing it is free:
the response is identical either way, and only a conflict with the caller's own
lesson carries the field-level diff.

### Batches return per-item results

One lesson failing a cross-field rule must not reject the other nineteen. A
client told only that "the batch failed" will re-push all twenty, and keep doing
it.

---

## Section 4 — The delta read *(approved)*

```
GET /lessons?since=<seq>&limit=<n>
Authorization: Bearer onlk_…

→ { lessons: [...], cursor: <highest seq delivered>, has_more: bool }
```

```sql
SELECT l.* FROM lesson_feed f JOIN lessons l ON l.id = f.lesson_id
WHERE f.user_id = ? AND f.seq > ? ORDER BY f.seq LIMIT ?
```

`since=0` is a full resync and is also the documented recovery path.

### The visibility filter is one function

`user_id` comes from the authenticated token and **never** from the request.

Contract spec Section 3 states the filter "is the security boundary. A bug there
leaks private lessons, so it belongs in exactly one place rather than spread
across every query site." That is a structural requirement, not advice: it is
implemented as a single function every read calls, because what makes a boundary
reviewable is that there is one thing to review.

### Contiguity is the client's check to make

The server returns a window and the cursor it reached. The client asserts the
`seq` values are contiguous with what it already holds. Receiving 101, 102, 104
proves 103 was skipped.

On a gap the client **refuses to advance its cursor and reports**. It does not
attempt repair — a client cannot see what it did not receive. Recovery is a full
resync from `since=0`, which is cheap at this scale.

This is what converts a lost lesson from an absence into an error. Without it, a
lesson that never syncs is indistinguishable from a lesson that was never
promoted, and nothing anywhere would report a problem.

---

## Section 5 — Failure modes and testing *(approved)*

Every entry is a way this subsystem fails *silently*. That is the class this
repository keeps getting hit by — the observability filter key that returned
success with zero matches, the apex-path heartbeat that stayed green through a
total outage, the brand tokens that were checked against nothing.

| Silent failure | What makes it loud |
|---|---|
| A lesson never reaches a machine | Dense feed plus the client contiguity check |
| The visibility filter leaks another user's lessons | One filter function; a test asserting user B's token returns zero of user A's rows |
| A cross-field rule cannot fire | One test per rule, violating **only** that rule |
| Re-push spuriously 409s | Round-trip test with deliberately reordered JSON keys |
| Two concurrent pushes collide | Assert the unique constraint forces a retry and yields two distinct adjacent `seq` values |
| A push returns 200 having stored nothing | Assert the feed advanced — not merely that the status was 200 |
| Server and plugins drift apart | `ZLesson` and the published JSON Schema must accept the same documents; `onlooker-1kg` already built the drift check |

### Every cross-field rule is mutation-tested

Each of the three rules has its guard removed, and a test must fail. A rule
whose test passes with the rule deleted is not a rule.

This is not a general policy applied for its own sake. `onlooker-59e` shipped two
brand tokens whose contrast guards could not fail, and it took mutating the
values to discover it — the suite was green at 59/59 the whole time. The three
rules here are the same shape: conditions that are rarely violated in practice,
so a test that silently stops checking looks exactly like a test that keeps
passing.

### Tests that must exist

**Contract:** a valid lesson round-trips; each cross-field rule rejects; a
`schema_version` other than 2 rejects.

**Auth:** unknown token 401s; revoked token 401s; one machine's revocation does
not affect another's; `last_used_at` advances.

**Feed:** `seq` is dense across creates and transitions; a transition appends
rather than moving a row; a deleted feed row is detectable as a gap by a
contiguity check.

**Boundary:** user B cannot read, transition, or conflict-probe user A's lessons.

---

## Open questions

**`author_key` cannot be verified by a server that must not be able to link
scopes.** The client derives `author_key = HMAC(user_master_secret, scope)`.
Verifying it requires the master secret, and the server *not* having it is
exactly what makes org and public identities unlinkable. But contract spec
Section 3 gives the field two jobs where forgery matters — org revocation and
public blocking — and a blocked actor who can assert any `author_key` simply
picks a new one.

Unlinkability and blocking are pulling against each other. This subsystem does
not resolve it and does not need to: `private` retrieval filters on `user_id`,
so nothing here trusts the field. It must be resolved before `org` ships, and
every stored lesson carries the field, so resolving it later is a data migration.

**The cursor mechanism for multi-author feeds is unsolved.** Per-user dense
`seq` gives contiguity for the only stream that exists today. A feed filtered
across many authors cannot be dense. The org and public specs need a different
mechanism, and it will not be a small change to this one.

**The counter-observation threshold** remains the open number it was in the
contract spec. Out of scope here, restated so it is not assumed closed.

---

## Where the work lands

| Repo | What |
|---|---|
| this one | All of it — `machine_tokens`, `lessons`, `lesson_feed`, the routes, the ingest rules |
| plugin repo | The mirror, the contiguity check, and the push on promotion |

The split follows the contract spec's Section 5 constraint: the server may
import zod, and the shell-based plugins may not.
