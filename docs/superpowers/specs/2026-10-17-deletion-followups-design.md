# Account and Org Deletion Follow-Ups — Design

Three issues the deletion work opened, settled in one conversation because
their decisions interlock.

| Linear | Bead | What |
| --- | --- | --- |
| [ONL-146](https://linear.app/onlooker/issue/ONL-146) | `onlooker-80b1o8` | A deleted account's access token keeps working for 15 minutes |
| [ONL-147](https://linear.app/onlooker/issue/ONL-147) | `onlooker-wrdnd4` | Accepting an invitation into a just-deleted org answers 500 |
| [ONL-145](https://linear.app/onlooker/issue/ONL-145) | `onlooker-4lgc3z` | The org retract has no server-side precondition |

All three became reachable through PRs #197–#203, which shipped org deletion,
org lesson retract, and account deletion.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-17.
Sections marked *(measured)* were read from this repository on 2026-10-17 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## What is there today *(measured)*

**The 15-minute window is a recorded decision, not an oversight.**
`packages/api-contract/src/index.ts:177-208` argues it out — "a stateless JWT
cannot be [withdrawn] — verification is a signature check with no lookup — so
any answer that claims otherwise is either a lie or a per-request database
read" — and lands on the residual access-token lifetime being deliberate,
because "a token denylist would close it completely at the cost of a KV read on
every authenticated request, forever; shortening the lifetime buys nearly the
same protection for nothing" (`:199-202`). `TOKEN_REVOCATION?: KVNamespace`
exists in `WorkerEnv` (`apps/api/src/types/index.ts:91`), bound nowhere, and is
documented as the attachment point in four files: `ENVIRONMENT_VARIABLES.md:288`
and `:327-332`, `apps/api/INTEGRATION.md:263-273`,
`apps/api/DEPLOYMENT.md:227`, and `apps/api/src/routes/auth.ts:334`.

ONL-146 is that same question asked about deletion rather than logout.

**`requireAuth` reads no database.** `apps/api/src/middleware/auth.ts:21-43`
builds its principal from the JWT payload alone — `userId: payload.sub` — so
nothing about a signed, unexpired token depends on its subject still existing.

**Deletion does not always delete.** `deleteUser`
(`apps/api/src/db/queries.ts:303`) returns `"deleted" | "anonymized" |
"sole_owner"`. An account holding org-shared lessons takes the anonymize path:
the `users` row **survives**, stripped of identity and credentials, with
`anonymized_at` set, because an org's lessons need an anchor. That path's own
comment already names this window — "`anonymized_at IS NULL` makes this
idempotent, which is reachable: an access token outlives its account for up to
TOKEN_EXPIRY_MINUTES" (`queries.ts:344-345`).

So **"the subject exists" is not the predicate** a revocation check would need.
It closes the window for hard deletes and silently misses every anonymized
account, while looking complete.

**One comment promises what the cascade cannot buy.**
`apps/api/src/routes/account.ts:291-294` reads "Sessions and verification
tokens both cascade from users, so this takes them with it — queries.test
asserts that rather than trusting it, because the day the constraint changes is
the day a deleted account keeps a working session." The cascade takes *refresh*
tokens, which is what a session is here; the access token the caller actually
holds is unaffected. The sentence is true about the constraint and misleading
about the consequence.

**Nothing asserts the window either way.** No test says a deleted account's
access token still authenticates, and none says it stops.

**The mock already disagrees with the API.**
`apps/web/src/api/mockApi.ts:424` deletes `MOCK_USERS[email]` on account
deletion, and its `requireAuth` (`:219-226`) resolves the user from that map and
throws 401 when absent. So after `DELETE /auth/account` the mock answers **401**
and the API answers **200**. No contract case can see it, because none makes an
authenticated call after a deletion. This is the class
[ONL-72](https://linear.app/onlooker/issue/ONL-72) exists for.

**Three retract paths, all delegating to one writer.** `transitionLesson`
(`apps/api/src/db/lessons.ts:310`) is the author path; `retractAnyLesson`
(`:372`) is the operator path; `retractOrgLesson` (`:406`) is the org-owner
path. The latter two are separate functions on purpose — their own comments
explain that widening one with a "skip the owner check" flag would put a
cross-owner write one wrong argument away from every ordinary transition — but
both end in `transitionLesson`. None checks the lesson's current status, so a
redundant retract writes a second `lesson_feed` row for a state change that did
not happen.

**`markInviteAccepted` precedes `addMembership` deliberately.**
`apps/api/src/routes/orgs-invite-accept.ts:115` spends the invitation token
before `:128` writes the membership, so two concurrent accepts resolve to
exactly one membership. If the org is deleted in between, `addMembership` writes
`org_id` against a row that is gone and raises `D1_ERROR: FOREIGN KEY
constraint failed`, which nothing catches.

**The constraint-error vocabulary is one function.**
`isUniqueViolationOn(error, table)` (`lessons.ts:93-99`) matches
`/UNIQUE constraint failed/i` **and** the table name, which SQLite includes in
that message. SQLite's foreign-key message does not name a table or column, so
the same shape cannot be copied verbatim.

## Decisions *(approved)*

### D1. The deletion window stays open, and the documentation stops over-promising

`requireAuth` gains no database read. The 15-minute access-token lifetime
remains the bound, consistent with the decision already recorded for logout in
`packages/api-contract`.

The reasoning that settled logout applies unchanged here: the alternative is a
per-request lookup forever, and the window is already bounded and cannot be
renewed (refresh tokens cascade with the user). ONL-146's own impact statement
is that reads scoped to a vanished `user_id` return empty and writes fail closed
on foreign keys, so what remains is the gap itself — a 200 where the system's
own documentation implies 401. The fix is to the documentation.

Rejected: **checking the subject in `requireAuth`.** One indexed read per
authenticated request, with the predicate `exists AND anonymized_at IS NULL`,
would close it immediately. It was declined on cost — six call sites already
read the user row (`account.ts:89`, `:134`, `:166`, `:382`,
`orgs-invite-accept.ts:96`, `auth.ts:308`), so avoiding a double read would mean
threading the row through the principal and changing its shape, and
`onlooker-wi9ftq.1.8` exists because two machine routes verify a credential
twice.

Rejected: **binding `TOKEN_REVOCATION`.** It is the named extension point, and
using it costs a KV read on every authenticated request — precisely the trade
`packages/api-contract:199-202` weighed and declined — plus a KV namespace the
API does not have.

### D2. The anonymize wrinkle is recorded where the next person will look

The `SESSION_LIFECYCLE` preamble and `ENVIRONMENT_VARIABLES.md:327-332` both
describe a denylist as the thing that would close the window. Neither mentions
that the anonymize path keeps the `users` row, so a reader who revisits the
trade and reaches for an existence check ships a half-fix that passes its own
tests. The note goes beside the existing `TOKEN_REVOCATION` text, in both
places, naming the predicate.

### D3. The mock stays stricter, and the divergence is written down

The mock's 401 is the behavior ONL-146 describes as desirable, and the API's
200 is the behavior D1 keeps. Teaching the mock to match would mean accepting a
deleted user's token for the rest of the dev session, because the mock has no
clock and cannot express "valid for 15 more minutes" — a worse lie in the other
direction.

So the divergence is deliberate and recorded, in the contract next to
`SESSION_LIFECYCLE` where this family of decisions already lives, with a comment
at the mock's delete branch pointing to it. Recording a known divergence in
writing is the pattern `scripts/sentry/unapplied.txt` established: "a written
admission, which is the point: the reason has to survive review."

Rejected: **a contract case pinning a shared status code.** There isn't one to
pin — the two implementations are correct for different reasons, and a case
asserting either number would make one of them fail for no benefit.

Rejected: **giving the mock a 15-minute tombstone.** Expressible — the mock can
read the clock — but it makes mock behavior time-dependent, which is how a
dev-mode fixture turns into a flaky test, in exchange for simulating a window no
developer is waiting out.

### D4. A redundant transition is idempotent, decided in `transitionLesson`

`transitionLesson` skips its batch when the stored state already equals what is
asked, and returns the lesson's existing `lesson_feed` seq instead of minting a
new one — specifically `MAX(seq)` over that lesson's own rows, scoped to the
author's stream as every feed read here is: `WHERE user_id = ? AND lesson_id = ?`.
That is the entry describing the state the caller asked for, which is what makes
returning it honest rather than merely non-null. All three retract paths inherit
the skip, so they agree — which is what
ONL-145 asks for, and what adding the check to `retractOrgLesson` alone would
not give: the operator path would go on writing duplicate feed rows, and the
three paths would disagree about whether a redundant retract is permitted.

The response shape does not change (`200 {id, seq, status}`), so no status code
moves, the api-contract needs no new number, the web mock needs no new branch,
and ONL-142's client-side gate stays exactly as it is.

Two conditions on the comparison:

* **`superseded_by` is part of it.** Retract passes `null`, so a lesson that is
  already `retracted` *with* a superseder is a real transition to `retracted`
  with none, and must still write.
* **The stored body counts, not only the column.** `transitionLesson` writes
  `status` into both `lessons.status` and the canonicalized `body`. Skipping on
  the column alone would leave a drifted body unrepaired, where today the
  redundant call happens to fix it. The skip requires both to already agree.

Rejected: **409 on a non-transition.** It says what happened, but `null`
already means "not found, or not yours" and maps to 404, so a second refusal
needs a return value distinguishable from it — changing `transitionLesson`'s
signature, the api-contract's status codes, and the mock, for three routes. And
since ONL-142 gates the UI control, the only human who ever sees this answer is
one holding a page that went stale, which is the case where a kind answer beats
a blunt one.

### D5. The invitation race answers 400 `invalid_invitation`

A `try`/`catch` around the single `addMembership` call
(`orgs-invite-accept.ts:128`) answers `400 invalid_invitation`, "That
invitation cannot be used" — the shape already used at `:87` and `:116`.

A new `isForeignKeyViolation(error)` mirrors `isUniqueViolationOn` but takes
**no table argument**, because SQLite's foreign-key message carries no table or
column name. That is also why the `catch` must wrap only that one call: an
unscoped catch would silently absorb a foreign-key failure from anywhere else
in the handler and report it as a bad invitation.

Consequence, stated rather than hidden: a concurrently deleted *account* raises
the same indistinguishable error, so the answer has to be true for both. "That
invitation cannot be used" is true in both cases, where a message naming the org
would not be.

The ordering at `:115-128` does not change. It is correct for its own reason,
and the foreign key — not the handler — is what protects integrity here; this
decision is only about what the caller is told.

## What changes *(proposed)*

### ONL-147 — PR 1

* `isForeignKeyViolation(error)` in a new `apps/api/src/db/constraints.ts`, with
  a comment on why it takes no table. The source guard matches lesson *queries*
  rather than imports (`scripts/source-guards.test.sh:186-196`), so a module that
  only tests an error string sits outside the lesson-visibility boundary and
  passes — whereas importing the helper from `db/lessons.ts` into a route would
  pass the guard and still read as a route reaching into the lesson-query home.
  `isUniqueViolationOn` stays where it is, with a one-line cross-reference:
  moving it would touch the lesson writer and its tests for no behavioral gain.
* `orgs-invite-accept.ts`: the scoped catch and the 400.
* A test that drives the race — org deleted between `markInviteAccepted` and
  `addMembership` — rather than asserting it cannot happen.

### ONL-145 — PR 2

* `transitionLesson`: the no-op precondition, the existing-seq read, and a
  comment on why both the column and the body are compared.
* Tests: a redundant org retract appends no second feed row and answers with the
  existing retract entry's seq; a lesson retracted, reactivated and retracted
  again answers with the latest of those entries rather than the earliest, which
  is what distinguishes `MAX(seq)` from a first-row read;
  `retracted`-with-superseder → `retracted`-with-null still writes; a
  drifted body is still repaired; the operator and author paths behave the same
  way as the org path.

### ONL-146 — PR 3

* Rewrite `account.ts:291-294` to say what cascades, what does not, and for how
  long, pointing at `SESSION_LIFECYCLE`.
* Add the anonymize-predicate note to the `SESSION_LIFECYCLE` preamble and to
  `ENVIRONMENT_VARIABLES.md:327-332`.
* Record the mock divergence in the contract; comment the mock's delete branch
  to point at it.
* A test asserting the window as a property: after `deleteUser`, a previously
  valid access token still authenticates, and the refresh token does not. The
  existing `queries.test` cascade assertion stays, with its claim narrowed to
  what it actually protects.

## Not in scope

* Binding `TOKEN_REVOCATION`, or any denylist. D1 declines it; D2 leaves the
  next reader equipped to revisit it.
* `requireAuth`'s signature and the principal's shape.
* ONL-148 and ONL-149, the two remaining deletion follow-ups.
* Anything about the ordering at `orgs-invite-accept.ts:115-128`.

## Verification

Each change ships with a test that drives its condition. Before any PR, all four
gates — the fourth is wired into no pnpm script and runs as a bare step in
`deploy.yml`, so a local `test`/`typecheck`/`lint` sweep does not reach it:

```
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/api typecheck
pnpm --filter @onlooker/api lint
bash scripts/source-guards.test.sh
```

ONL-146's PR touches `apps/web` and `packages/api-contract` as well, so those
filters run too.

## Shape

Three PRs, independent, in the order above: ONL-147 first because it is a live
500, then ONL-145, then ONL-146. Branches `meagan/onl-147-*`, `meagan/onl-145-*`,
`meagan/onl-146-*`, so Linear links itself. This document lands with PR 1 and the
later two reference it.
