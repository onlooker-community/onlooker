# Org Visibility Tier — Design

Bead: `onlooker-wi9ftq` ([ONL-12](https://linear.app/onlooker/issue/ONL-12)),
whose child `onlooker-wi9ftq.1` specified and shipped the shared read path this
document plugs into
(`docs/superpowers/specs/2026-09-27-shared-lesson-read-path-design.md`, PR #188).

A lesson marked `org` should be readable by the author's org and nobody else.
The read machinery for that already exists and is deployed. What does not exist
is an org: no table, no membership, no invitation, no notion anywhere in the
product that two accounts belong together. This document specifies that, fixes
a correctness bug in the shipped predicate that only becomes reachable once
orgs exist, and opens the push gate for `org` as its last step.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-04.
Sections marked *(measured)* were read from this repository on 2026-10-04; each
names the file and line the fact came from, so a reader can check it rather
than trust it. Sections marked *(proposed)* are this document's own
recommendations, presented but not separately ratified — the review of this
spec is where they get accepted or cut.

## What exists today *(measured)*

**There is no org anywhere.** `packages/db/src/schema.ts` declares `users`
(:18), `sessions` (:46), `verification_tokens` (:79), `machine_tokens` (:120),
`lessons` (:173), `lesson_feed` (:269), `lesson_author_blocks` (:299) and
`session_summaries` (:324). None of them mentions an organization, a team or a
membership. `users` holds `id`, `email`, `password_hash`, `name`,
`email_verified`, `created_at`, `updated_at` and nothing else.

**The read seam is built and inert.** `apps/api/src/db/pool.ts:40` declares
`OrgMembers = (db, userId) => Promise<string[]>`, and `:92` is the stub
`noOrgMembers` returning `[]`. Its contract, stated at `:22-40`: return the
user_ids sharing an org with `userId`, never include a non-member, and never
throw — an org that cannot be resolved returns `[]`, so a membership outage
narrows access instead of widening it.

**The push gate is half open.** `apps/api/src/routes/lessons.ts:118` rejects
every visibility that is not `private` or `public`. `public` opened 2026-10-03;
`org` stays shut, and the comment at `:105-112` records that the reason is
specifically this stub — an org lesson admitted today would be readable only by
its author and would become org-visible *retroactively* the day the resolver
lands, which is a disclosure its author never consented to.

**Route authentication is declarative, and resource authorization is not.**
`Route` (`apps/api/src/router.ts:57-66`) requires `auth` and `cors` on every
entry, enforced by the compiler rather than a test. `RouteAuth` admits `none`,
`session`, `machine` and `operator`. `dispatch` resolves a principal from the
credential before the handler runs. `Principal` (`pool.ts:18`) carries only
`userId`.

**`/api/` is where the contract gate reaches.** `router.ts:355-359` records
that a route outside that prefix "cannot be mocked by createMockFetch and
cannot be reached by an api-contract case — which is how the machine-token
surface spent three PRs as the only one outside the drift gate."
`packages/api-contract/src/index.ts:3-30` explains why that table exists: it is
asserted against both the real worker and the web mock, so neither can drift
alone.

**Email is infrastructure that already exists.** `sendEmail`
(`apps/api/src/email/`) sends through Resend. `createVerificationToken`
(`apps/api/src/db/queries.ts:369`) mints 32 bytes of crypto random, hex
encoded, returns the raw value once and stores only its SHA-256. Expiry is
compared in TypeScript, not SQL, because `expires_at` holds an ISO string and a
SQL comparison would be lexicographic (`queries.ts:180`, and again at `:442`).

**Two different homes for a token lifetime.** `RESET_TOKEN_TTL_MS` (1 hour) and
`VERIFY_TOKEN_TTL_MS` (24 hours) are constants in
`apps/api/src/email/templates.ts:18` and `:24` — beside the templates that tell
the reader when the link dies. `TOKEN_EXPIRY_MINUTES` and
`REFRESH_TOKEN_EXPIRY_DAYS` are instead `wrangler.toml` vars, declared in all
three environments (`apps/api/wrangler.toml:46-47`, `:99-100`, `:164-165`).

## The bug this spike found *(measured)*

The shipped predicate (`pool.ts:145-185`) authorizes the org disjunct like
this:

```sql
visibility = 'org' AND user_id IN (<the reader's org-mates>)
```

It keys on **who the author is**, not on **which org the lesson was shared
with**. That is correct if and only if a user belongs to at most one org. It
over-shares the moment they can belong to two:

> Alice is in org A and org B. Bob is in A only, Carol is in B only. Bob and
> Carol share no org. Alice pushes one `org` lesson — and because each of them
> shares *an* org with Alice, **both can read it**. Alice was never asked which
> org she meant, and the lesson carries no answer: `lessons` has no `org_id`.

This is unreachable today, because `noOrgMembers` returns `[]` and the gate
rejects `org` pushes. It becomes reachable the moment either changes, which is
to say the moment this document is implemented. So it is this issue's to fix,
not a follow-up.

The fix also deletes a constraint rather than working around it.
`MAX_ORG_MEMBERS_BOUND = 50` (`pool.ts:118`) exists because the predicate binds
one `?` per member against D1's 100-bound-parameter cap, and `pool.ts:101-117`
is explicit that this is a hard ceiling an org cannot exceed at all — past it,
`visibilityPredicate` truncates and silently stops recognizing members.
Rekeying on the lesson's org makes the bind count scale with how many orgs the
*reader* belongs to, which is one or two, so the ceiling and its truncation
both go away.

## Decisions *(approved)*

**D1. Membership is by email invitation.** An owner invites an address; the
invitee accepts. Not domain-derived (which silently co-orgs strangers on
`gmail.com`), not link-based (a leaked link is an unbounded grant on a tier
whose purpose is confidentiality), not operator-seeded (self-serve from the
start).

**D2. A user may belong to any number of orgs, and a lesson names the org it
was shared with.** `lessons` gains `org_id`; the predicate rekeys onto it. This
is the fix for the bug above, and it is what makes a consultant in two client
orgs representable.

**D3. The server stamps `org_id` from the push credential.** The lesson
contract gains no org field. A machine token is bound to one org when minted,
and the server reads the org from the token rather than from the request. A
client cannot name an org its holder does not belong to, and a stolen token
cannot be retargeted. The cost is one token per org.

**D4. An org lesson is attributed by name to members of that org.** Resolved
server-side from `lessons.user_id`. Lessons are advice, and knowing which
teammate wrote one is how a reader weighs it and asks a follow-up. This leaves
`author_key`'s guarantee intact: that field is about not being linkable *across
scopes*, not about anonymity *within* one, and a public row's disclosure does
not change.

**D5. Two roles, `owner` and `member`, and an org may have several owners.**
Owners invite, remove, rename and promote; members read and push. Several
owners is the same column as one and solves the bus factor without an
ownership-transfer flow. The last owner cannot be removed or demoted.

**D6. A lesson shared with an org survives its author's departure, and owners
can retract one.** The author shared it deliberately, and a team should not
lose its accumulated knowledge at the moment the person who had it leaves. The
org-level retract keeps that from making the operator the moderation queue for
every customer.

*Scoped precisely, because the schema already decides half of this.* D6 governs
**leaving an org**, which is a row removed from `org_memberships` and leaves the
lesson untouched. It does **not** govern **deleting an account**:
`lessons.user_id` carries `onDelete: "cascade"` (`schema.ts:177-179`), so
`DELETE /auth/account` destroys the author's lessons, org-visible ones included,
and an org loses them. That behavior is unchanged by this document and is listed
as deferred below — but it is written here so D6 is not read as a guarantee it
does not make.

**D7. The invite window is configuration, defaulting to 7 days.**
`INVITE_EXPIRY_DAYS`, a `wrangler.toml` var beside `TOKEN_EXPIRY_MINUTES`,
read through a resolver that already takes the org as an argument so a per-org
override is later a column and a line inside that function rather than a
refactor. Seven days because an invite waits on a human who may be away, where
a password reset waits on someone actively trying to get in.

## Two stages, one spec *(approved)*

Every decision above is one product choice, so splitting the spec would make
the second half re-litigate the first. The implementation splits cleanly, and
gets a bead tree each:

**Stage 1 — org accounts.** `orgs`, `org_memberships`, `org_invites`, the
invite email, the routes, the web settings surface. Touches nothing about
lessons, and discloses nothing: an org with members but no lesson tier shares
no content.

**Stage 2 — the org lesson tier.** `lessons.org_id`, `machine_tokens.org_id`,
the predicate rekey, attribution, owner retract, and the push gate opening for
`org` as the final step. This is what the Linear milestone measures: two
accounts in one org each see the other's org-tier lessons, an account outside
the org sees none, and a contract test pins both cases.

The coupling rule from the shipped design survives: the resolver and the gate
open in the same change. It now lands at the end of stage 2 rather than binding
the stages together.

## Data model

```
orgs              id, name, created_at, updated_at

org_memberships   id, org_id, user_id, role('owner'|'member'), created_at
                  UNIQUE(org_id, user_id)        -- one row per pair
                  INDEX(user_id)                 -- the resolver's read

org_invites       id, org_id, email, role, token_hash, expires_at,
                  invited_by, accepted_at, created_at
                  UNIQUE(token_hash)
                  INDEX(org_id, email)           -- pending lookup, replace-on-reinvite

lessons           + org_id   TEXT, nullable
machine_tokens    + org_id   TEXT, nullable      -- null means a private-only token
```

`org_id` on `lessons` earns a column under the table's own stated rule — "only
the fields the server filters or orders on are lifted into columns"
(`schema.ts:161`) — because the predicate filters on it. Both new columns are
nullable rather than defaulted, which sidesteps the SQLite constraint
`promoted_at` and `author_key` both document: `ADD COLUMN ... NOT NULL` is
refused without a non-NULL default even on an empty table. A nullable column
needs no backfill and no `''` sentinel that later has to be reasoned about.

`packages/db/src/expected-schema.ts` is updated in the same change as each
migration, so the deployed-schema drift check stays honest.

### Foreign keys

`org_memberships.user_id` and `org_memberships.org_id` both cascade, so
deleting an account takes its memberships and deleting an org takes its member
list. `org_invites.org_id` and `org_invites.invited_by` cascade for the same
reason — a pending invite from a deleted account, or into a deleted org, should
not stay live.

`lessons.org_id` sets null rather than cascading. Combined with the predicate,
that is the safe direction: an `org` lesson whose org is gone has a NULL
`org_id`, matches nothing, and becomes unreadable rather than orphaned into
something broader. Nothing exercises it in stage 1 — there is deliberately no
`DELETE /api/orgs/:id` route, so an org cannot yet be deleted — but the
migration has to choose, and this is the choice that fails closed.

## The predicate

One disjunct changes:

```sql
-- before: authorizes on who the author is
visibility = 'org' AND user_id IN (<the reader's org-mates>)
-- after:  authorizes on which org the lesson was shared with
visibility = 'org' AND org_id IN (<the reader's orgs>)
```

`OrgMembers` becomes `OrgIds: (db, userId) => Promise<string[]>` — same arity,
same never-throw-return-`[]` contract, same fail-closed-on-outage property, but
returning org ids rather than member ids. The rename is not cosmetic: a function
whose name says "members" and whose values are orgs is the kind of thing a
later reader fixes in the wrong direction.

Three properties follow, written down because a reader cannot otherwise tell
whether they were considered:

- **A NULL `org_id` matches nothing.** `org_id IN (...)` is never true for
  NULL, so an `org` row that somehow lacks an org fails closed rather than open.
- **The author's own membership is never consulted.** D6 is therefore not a
  special case — surviving the author's departure is the only thing this
  predicate can do.
- **`MAX_ORG_MEMBERS_BOUND` is deleted, not raised.** A bound stays for D1's
  100-parameter cap, renamed to reflect that it now limits how many orgs one
  reader may have in a single query, which nobody will reach.

The anonymous read is untouched: the org disjunct sits inside the
`if (principal)` branch, as the public one deliberately does not.

## Stage 1: org accounts

### Routes *(proposed)*

All under `/api/`, for the drift-gate reason measured above.

| Method | Path | Role |
|---|---|---|
| POST | `/api/orgs` | session; creator becomes owner |
| GET | `/api/orgs` | session; my orgs and my role in each |
| PATCH | `/api/orgs/:id` | owner — rename |
| GET | `/api/orgs/:id/members` | member |
| POST | `/api/orgs/:id/invites` | owner |
| GET | `/api/orgs/:id/invites` | owner — pending |
| DELETE | `/api/orgs/:id/invites/:inviteId` | owner — revoke a pending invite |
| GET | `/api/orgs/invites/verify` | `auth: "none"` — the org and inviter, before accepting |
| POST | `/api/orgs/invites/accept` | session |
| PATCH | `/api/orgs/:id/members/:userId` | owner — promote or demote |
| DELETE | `/api/orgs/:id/members/:userId` | owner for anyone; any member for their own id — "leave" is the self case |

`PATCH /api/orgs/:id` is the one route the milestone's done-when does not
require. It is here because an org whose name was typed once and can never be
corrected is a poor thing to hand someone, but it is the obvious cut if stage 1
needs to be smaller.

`GET /api/orgs/invites/verify` takes `auth: "none"` for the reason
`/auth/reset-password/verify` does: the credential is the token in the request,
not a session.

Its literal `invites` segment does not collide with the parameterized routes,
and this was checked rather than assumed. `matchPath` (`router.ts:427`) requires
every non-parameter segment to match literally and segment counts to agree, so
`/api/orgs/invites/verify` fails `/api/orgs/:id/invites` at the last segment
(`invites` ≠ `verify`) after `:id` happily captures `invites`. `resolve` also
prefers exact routes over parameterized ones, so table ordering does not matter
here. What *would* collide is a later `/api/orgs/:id/:resource`, and nothing
should add one.

### Role authorization is a chokepoint, not a route field *(proposed)*

`RouteAuth` cannot express "owner of the org named in this path", and should not
be made to. `dispatch` resolves a principal from the credential alone, before
the handler runs; an org role depends on a path parameter and a database read.
Adding `auth: "org-owner"` would put resource authorization into a table that
can only honestly declare credential authorization, and would make the table
look authoritative for a question it cannot answer.

Instead, one function —
`requireOrgRole(env, principal, orgId, "owner" | "member")` — returns the
membership row or throws. It is the first statement of every org handler, which
is the same shape as the read path's single `readPool` chokepoint and for the
same reason.

What keeps it from being auth-by-omission, which is the thing the shipped design
existed to end: **an enumerated contract test**. A table lists every
`/api/orgs` route with the role it requires; the test asserts that a non-member
receives 404 on each, and that a plain member receives 404 on each owner route.
Adding an org route without an entry in that table fails, exactly as the
existing enumerations pin the `auth: "none"` and `cors: "any"` sets. The
enumeration is the guard; the function is only where the check lives.

`DELETE /api/orgs/:id/members/:userId` is the one route whose required role
depends on its arguments — an owner may remove anyone, and a plain member may
remove only themselves. It is marked as that in the table rather than left to
the blanket rule, and it carries its own pair of tests: a plain member removing
their own id succeeds, and a plain member removing another member's id gets 404.
Writing the exception down is the point; a single route that quietly fails the
enumeration's general claim is how an allowlist stops meaning anything.

**404, not 403**, matching the operator surface (`router.ts:372`): an org you do
not belong to should not confirm that it exists.

### The invite *(proposed)*

Its own table rather than a `verification_tokens` row, because that table is
keyed to a `user_id` (`schema.ts:79`) and an invitee may have no account yet.

Same primitives as the existing email flows: 32 crypto-random bytes hex
encoded, SHA-256 stored, raw value returned exactly once, expiry compared in
TypeScript because `expires_at` is an ISO string.

**The token is not the whole credential.** Accepting requires a session *and*
the invite's `email` matching the authenticated account's, compared
case-normalized. This is what keeps D1 from collapsing into the link-based
membership it rejected: a forwarded or leaked invite does nothing for anyone but
the addressee. `Principal` carries only `userId`, so accept reads the email from
D1 — a query, not a second credential.

The rest of the lifecycle:

- Single use. `accepted_at` is stamped; a replay is 400.
- Re-inviting a pending address **replaces** the outstanding invite, mirroring
  the delete-then-create at `account.ts:332`, so one inbox never holds two live
  invites.
- Inviting an existing member is 409.
- An address with no account still gets a working `verify`, showing the org
  name; the web flow routes them through signup and back to accept.
- Revoking a pending invite deletes the row, so the link stops working.

### The invite window *(approved)*

`INVITE_EXPIRY_DAYS`, declared in all three `[env.*.vars]` blocks of
`apps/api/wrangler.toml` beside `TOKEN_EXPIRY_MINUTES`. Three requirements make
it configuration rather than a new failure mode, each one a shape this repo has
already been bitten by:

1. **The email renders the window from the same value it enforces.** The reason
   the other TTLs live in `templates.ts` is that the message states when the
   link dies. Moving the number to config and leaving the prose static ships an
   email that lies, so the template takes the resolved value as an argument.
2. **It is parsed with a fallback, not read bare.** `Number("")` is `0` and
   `Number("seven")` is `NaN`; a window of zero means every invite is born
   expired and the whole flow fails silently. A missing or unparseable value
   falls back to 7 and warns. Falling back rather than throwing, because a
   typo'd var should not take invites down — `onlooker-nsow87` is an open bug of
   exactly this shape, where a typo in `CLIENT_ERROR_LOOKBACK_MINUTES` produces
   a false alert nobody notices.
3. **`ENVIRONMENT_VARIABLES.md` gets the entry in the same change**, or
   `scripts/source-guards.test.sh:217` fails CI.

This does not avoid a deploy; `wrangler.toml` vars change by deploying. What it
buys is a value visible in environment config, reviewable per environment, and
able to differ — a one-day window in development makes expiry cheap to exercise
by hand.

The resolver takes the org as an argument from the start, so D7's per-org
override is later a column plus a line inside one function.

### Web surface *(proposed)*

Org management hangs off the existing `SettingsPage.tsx`: create an org, see
members and roles, invite, revoke, promote, remove, leave. A new page for
accepting an invite, mirroring `VerifyEmailPage.tsx` and `ResetPasswordPage.tsx`
— which is also where the signup detour for a brand-new invitee lives.

Every new route gets a `@onlooker/api-contract` entry in the same change, so the
mock and the worker cannot drift apart.

## Stage 2: the org lesson tier

### Push *(proposed)*

A machine token carries `org_id`; the server stamps it onto the lesson. A
`visibility: "org"` push on a token with no org is rejected with a message
naming **the token**, not the lesson: the author's mistake is which credential
they used, and an error about the lesson would send them to the wrong place.

The token-minting surface gains an org picker. Existing tokens keep `org_id`
NULL and stay private-only, so nothing in production changes behavior on deploy.

### The index, and a plan this document will not predict *(proposed)*

The org disjunct wants an index on `(visibility, org_id, promoted_at, id)`. But
`apps/api/src/db/pool-query-plan.test.ts` hands `readPool` a recording stand-in
for D1, captures the statement actually prepared and EXPLAINs it — and
`pool.ts:64-80` documents that a disjunction already forces a `MULTI-INDEX OR`
plus `USE TEMP B-TREE FOR ORDER BY`, because a union of index scans is not
ordered by `promoted_at`.

A third disjunct changes that plan in ways a spec should not guess. So the plan
is **re-measured** against a database built from the real migrations, and the
measured output is written into this document before the index is considered
settled. Stating a predicted plan here would be the same error the repo's own
notes keep catching.

### Attribution *(proposed)*

The join to `users` lives inside `readPool` rather than in a new org module,
because `scripts/source-guards.test.sh` enforces that no file under
`apps/api/src` outside the named owners may query `lessons` or `lesson_feed`. A
new query home fails that guard until the allowlist names it, and it fails as a
bare bash step that no local sweep and no diff review reaches.

`author_name` attaches only to rows that reach the reader through the org
disjunct. A public row still carries `author_key` alone, so the anonymous
surface's disclosure is unchanged and nothing links an author across tiers.

### Owner retract *(proposed)*

`POST /api/orgs/:id/lessons/:lessonId/retract`, owner only. A **third**
function, separate from both `transitionLesson` (`db/lessons.ts:287`, whose
`WHERE id = ? AND user_id = ?` at `:316` stays the user-facing guarantee) and
`retractAnyLesson` (`:349`, the operator path) — per the shipped rule that a
cross-owner write must not be reachable by passing the wrong argument to the
ordinary one.

It requires the lesson's `org_id` to equal the path's org, so an owner of org B
cannot retract inside org A.

### The gate opens

`routes/lessons.ts:118` admits `org`. Last step of stage 2, in the same change
as the resolver.

## Tests

Two carry the most weight:

1. **The milestone's done-when, verbatim.** Two accounts in one org each read
   the other's org lessons; an account outside the org reads none; a contract
   test pins both.
2. **A regression test for the bug in this document.** Alice in orgs A and B, a
   lesson shared with A, Carol in B reads nothing. This one must be *shown to
   fail against the shipped author-keyed predicate* — restore the old disjunct,
   watch it pass wrongly, put the new one back. A test for a bug nobody has
   watched fail is not evidence the bug is fixed.

Every leak test is ablation-proven, as the shipped design requires: delete the
predicate, watch the test fail, restore it. Beyond those:

- `visibility = 'org'` with a NULL `org_id` matches nothing, for any reader.
- An author leaves an org: the org still reads their lesson, and they stop
  reading the org's others.
- The last owner cannot be removed or demoted.
- `OrgIds` throwing results in a narrowed read, not a widened one — the
  never-throw contract observed rather than assumed.
- An org member still cannot read a fellow member's `private` lessons.
- Invites: a valid token held by the wrong account is refused; expiry; replay;
  replace-on-reinvite; existing-member 409; a revoked invite stops working.
- The anonymous `GET /api/public/lessons/:id` still 404s an `org` lesson.
- The route-and-role enumeration described above.
- The query plan, re-measured.

### Gates

**Four, not three**, per this repo's own correction after PR #188 passed every
local gate and failed CI:

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

The fourth is wired into no pnpm script — it runs as a bare bash step in
`.github/workflows/deploy.yml`, so no local sweep touches it and no review of a
diff can see it. Two of its checks are live for this work: the lesson-visibility
boundary allowlist, and the `WorkerEnv`-to-`ENVIRONMENT_VARIABLES.md` pairing
that `INVITE_EXPIRY_DAYS` must satisfy.

## Boundary changes to sibling issues

- **ONL-13** (`onlooker-7x1khc`, public tier) is unblocked by
  `onlooker-wi9ftq.1` rather than by this document, and its remaining question
  is whether the public tier requires `agreed == judges`. The only consensus
  check anywhere is at `apps/api/src/lessons/rules.ts:78`. Nothing here settles
  it.
- **`onlooker-wi9ftq.1`** is merged and deployed (PR #188, plus #189–#194) and
  should be closed. Its own notes list "fill `OrgMembers`" as what remains,
  which is this document.
- **`onlooker-wi9ftq.1.8`** (two machine routes verifying their credential
  twice) is untouched by this work and stays where it is.

## Deferred, each to its own issue

- **Per-org invite windows.** D7 shapes the resolver for it; no column, no
  settings surface, no decision about what a member sees.
- **Foreign lessons entering the CLI's local mirror.** Already deferred by the
  shared read-path design, and unchanged by this one: an org lesson is readable
  through the API but does not enter a member's local mirror, so local
  always-on retrieval still matches only your own lessons.
- **Org-level moderation beyond retract.** No report queue, no author blocking
  scoped to an org; the global operator controls remain the escalation path.
- **Account deletion destroys org lessons.** `lessons.user_id` cascades
  (`schema.ts:177-179`), so an author deleting their account takes the lessons
  their org was relying on. Fixing it is not a one-line change: `user_id` is
  `notNull`, so a lesson cannot simply be detached from its author, and the
  alternatives — a tombstoned user row, or transferring ownership to the org —
  are both account-deletion semantics rather than visibility ones. Worth an
  issue of its own, and worth filing before the first real org exists.
- **Deleting an org.** No route for it, which is why `lessons.org_id` sets null
  on delete without anything exercising that path yet.
- **Nested orgs, per-project orgs, and anything resembling a group within an
  org.** A lesson names one org.
- **`author_key` is client-supplied.** The server indexes a value the author's
  own machine derives (`packages/lesson-contract/src/lesson.ts:67`), so a
  blocked key can in principle be replaced by its holder. That is unchanged by
  this work and belongs with ONL-13's abuse boundaries, but it is load-bearing
  for org revocation too and should not stay unwritten.
