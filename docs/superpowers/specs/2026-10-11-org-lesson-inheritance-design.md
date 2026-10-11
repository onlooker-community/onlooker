# Org Lessons Outliving Their Author — Design

Bead: `onlooker-px7ssn` ([ONL-136](https://linear.app/onlooker/issue/ONL-136)),
the parent. Its two siblings have shipped: account deletion refuses while you
are an org's sole owner (PR #198), and a sole member can delete the org itself
(PR #199, deployed and verified 2026-10-11). This is the arm the bead was
blocked on, and the block was a product decision rather than a technical one.

**A lesson shared with an org survives its author's account deletion and stays
with the org.** Today `lessons.user_id` is `notNull` with `onDelete: "cascade"`
(`packages/db/src/schema.ts:188-191`), so deleting an account destroys every
lesson it ever wrote, including the ones it shared with other people.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-11.
Sections marked *(measured)* were read from this repository on 2026-10-11 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## What the constraint actually is *(measured)*

The `notNull` column is the obvious obstacle and not the real one.

**Every status change writes to the author's own feed.** `transitionLesson`
(`apps/api/src/db/lessons.ts:307`) allocates
`SELECT COALESCE(MAX(seq), 0) + 1 FROM lesson_feed WHERE user_id = ?` and
inserts a `lesson_feed` row under that `user_id`, and `lesson_feed.user_id`
references `users` with `onDelete: "cascade"`
(`packages/db/src/schema.ts:308-310`). So a lesson that outlives its author
cannot be retracted by anybody: the write violates a foreign key.

That matters because the org-level retract exists specifically so the platform
operator is not the moderation queue for every customer — D6 of the org
visibility design, and the whole subject of PR #197. An org lesson nobody can
retract hands that moderation straight back to the operator, which is the
outcome this project has now decided against twice.

**Pseudonymous attribution already survives.** `lessons.author_key` is
`notNull`, 128 bits, on every row, and independent of `user_id`
(`schema.ts:218`). What does not survive is the display name, which resolves
from `users.name` through `user_id`.

**A null name is already meaningful.** `authorNames` (`apps/api/src/db/pool.ts:360-363`)
deliberately emits no key for a null or empty name — "the server does not
invent a label for a member who never set one" — and
`apps/web/src/pages/LessonDetail.tsx:569` renders no attribution block when
the name is absent.

**Blocks do not key on the author's account.** `lesson_author_blocks`
(`schema.ts:334`) keys on `author_key`, so a blocked author cannot evade a
block by deleting their account. This design must not break that.

## Decisions *(approved)*

**D1. Deletion becomes anonymization only when something needs the anchor.**
An account with no surviving org lessons is still deleted outright, row and
all, which is most accounts. An account with surviving org lessons has its
`users` row kept as an anchor and stripped of identity.

Minimal retention is the right default for a deletion feature, and it keeps
"delete my account" literally true for the common case. The alternative —
always anonymize — keeps a row forever for every account that ever existed,
which is a worse privacy posture bought for a simpler code path.

**D2. Only org-shared lessons survive.** `visibility = 'org'` with a non-null
`org_id`. Public and private lessons are deleted with the account.

The rationale is the one that settled the decision: a team has a claim on what
was shared with it. A public lesson's readers are not a team, and publishing to
the world then closing the account reads as a withdrawal. A private lesson
would be permanently unreadable — nobody can authenticate as an anonymized
row — so keeping one would be keeping garbage.

**D3. Anonymization strips identity and credentials, and records that it
happened.** `email` replaced with a unique unusable value, `password_hash`
replaced, `name` and `email_verified` set to NULL, and a new nullable
`users.anonymized_at` timestamp set.

The column earns its place twice over: it is what lets attribution distinguish
a departed author from a member who never set a name (D4), and it is what lets
a second deletion attempt answer "already gone" without parsing an email for a
pattern.

**D4. Attribution says "Former member".** The server marks the lesson as
having an anonymized author; the client renders that rather than leaving the
attribution block empty.

Without this, a departed author and a member who never set a name render
identically, which conflates two different facts. The useful one for a reader
is that nobody can answer a follow-up question about this lesson and only an
owner can retract it.

**D5. The confirm copy must be true in both paths.** It currently promises
"Permanently delete your account and all associated data. This cannot be
undone", which becomes false in two ways. This design owns correcting it:
lessons shared with an org stay with the org, and the account becomes unusable
rather than erased.

Naming *which* orgs and *how many* lessons stays with `onlooker-px7ssn.5`,
which already owns the delete-account flow and is already fetching error
details there for the sole-owner 409. The two can land in either order.

## What each dependent does *(proposed)*

Seven tables reference `users.id`, every one with `onDelete: "cascade"`. On the
delete path they all still fire by themselves. **The table below is the
anonymize path only**, where nothing cascades because nothing is deleted.

| table | what happens | why |
|---|---|---|
| `sessions` | deleted | a live session would outlive the account |
| `verification_tokens` | deleted | same, and a pending reset must not resurrect the account |
| `machine_tokens` | deleted | **security-critical**: a surviving token authenticates *as* the anonymized row, which no password can reach but a bearer token would |
| `session_summaries` | deleted | the person's own telemetry; no org has a claim on it |
| `org_memberships` | deleted | otherwise the org lists a ghost member, and the member list is what gates org deletion |
| `lessons` | selective: `visibility = 'org' AND org_id IS NOT NULL` survive, everything else deleted | D2 |
| `lesson_feed` | kept for surviving lessons | `transitionLesson` allocates `MAX(seq) + 1` for this `user_id`, so the history is what keeps a later org retract's sequence correct. Rows for deleted lessons go on their own: `lesson_feed.lesson_id` cascades from `lessons` |

`org_invites.invited_by` also references `users` (`schema.ts:477-479`) and those
rows **stay**. An invitation belongs to the org, `invited_by` is provenance
only, and an org may want a pending invitation honored after the inviter
leaves.

## Atomicity, which is where this gets interesting *(proposed)*

#198 folded its sole-owner refusal into the `DELETE`'s own `WHERE` clause
because a read-then-write lets two concurrent requests both see two owners
before either lands, leaving zero. That reasoning still holds, and it now has
to survive a multi-statement operation.

**The delete path does not change.** The existing guarded `DELETE FROM users`
stays exactly as it is, except for one added condition (below). Every cascade
fires. No new code runs. This is deliberate: the common path keeps the shape
that has been reviewed, deployed and verified.

**The delete path gains one condition**, so the choice between paths cannot be
raced:

```sql
DELETE FROM users
 WHERE id = ?
   AND NOT EXISTS (<the existing sole-owner subquery>)
   AND NOT EXISTS (SELECT 1 FROM lessons
                   WHERE user_id = ? AND visibility = 'org' AND org_id IS NOT NULL)
```

Deciding "this account has no org lessons" with a read and then deleting would
let a lesson pushed in between be cascaded away — the exact loss this design
exists to prevent. With the condition inline, that delete refuses, and the
caller's retry lands on the anonymize path instead.

**The anonymize path is one `db.batch`**, which is one transaction in D1. The
`UPDATE` comes first and carries the sole-owner guard; every cleanup statement
is conditioned on that update having taken effect, which it can observe
because they share the transaction:

```sql
-- first
UPDATE users
   SET email = ?, password_hash = ?, name = NULL, email_verified = NULL,
       anonymized_at = ?
 WHERE id = ? AND anonymized_at IS NULL
   AND NOT EXISTS (<the existing sole-owner subquery>);

-- then each cleanup, e.g.
DELETE FROM machine_tokens
 WHERE user_id = ?
   AND EXISTS (SELECT 1 FROM users WHERE id = ? AND anonymized_at IS NOT NULL);
```

So a refused guard leaves the account completely untouched rather than
half-dismantled, and the operation is idempotent: a second attempt matches no
row on `anonymized_at IS NULL` and changes nothing.

**The sequence, stated rather than implied.** No pre-read decides the path;
the delete attempt does, because only the write can decide without a race:

1. Attempt the guarded `DELETE` above. If it changes a row: `"deleted"`, done.
2. Zero rows means one of three things, and one read each tells them apart —
   the same disambiguation #198 already performs, extended by one case:
   - `soleOwnedOrgs` returns orgs → `"sole_owner"`. The 409, unchanged, and
     nothing has been written.
   - the account has at least one `visibility = 'org'` lesson with a non-null
     `org_id` → run the anonymize batch → `"anonymized"`.
   - neither → the account was already gone. Report success, preserving #198's
     stated intent that a caller who wanted it gone and finds it gone is not
     an error.
3. The reads cannot invert a decision. The delete has already refused
   authoritatively; they only choose which of three answers the caller gets,
   and the anonymize batch re-checks the sole-owner guard in its own `WHERE`
   rather than trusting what the read said a moment earlier.

Order matters within step 2: the sole-owner check must precede the org-lesson
check, or an account that is both a sole owner and has org lessons would be
anonymized while still owning an org — leaving the org with zero owners, which
is the invariant #198 shipped to protect.

**The replacement values.** `password_hash` becomes a real bcrypt hash of a
discarded random value, not a sentinel string. `verifyPassword` calls
`bcrypt.compare` (`apps/api/src/utils/crypto.ts:23-28`), and handing it a
string that is not a bcrypt hash has no defined answer; a valid hash of
something nobody knows returns false for every guess, which is the behavior
wanted. It costs one bcrypt at cost 10 on a once-per-account operation.

`email` becomes `deleted+<uuid>@deleted.invalid`. `.invalid` is reserved by
RFC 2606 so it can never be a real address, and the UUID keeps
`users_email_idx` satisfied. Signup does not validate the domain, so a
determined person could in principle register such an address; a v4 UUID
collision is implausible, and the unique index would reject the update rather
than corrupt anything.

## The API surface *(proposed)*

`deleteUser` returns one more outcome. Today it is
`"ok" | "sole_owner"`; it becomes
`"deleted" | "anonymized" | "sole_owner"`.

The route's answer is unchanged for the refusal (409 `sole_owner`, with the
orgs named) and unchanged in shape for success — `{ success: true }` either
way. A caller does not need to know which path ran, and telling them would
leak how many org lessons they had to anybody who could trigger the call.

Whether the response should distinguish them for the UI's benefit is a question
for `onlooker-px7ssn.5`, which is the bead that renders the outcome.

## Attribution shape *(proposed)*

The `authors` sidecar keys lesson id to a display name and emits no key when
there is none. It gains a sibling rather than a magic string:

```json
"authors": { "01KA...": "Ada" },
"former_authors": ["01KZ..."]
```

`former_authors` is an **array of lesson ids** whose author is anonymized,
always present and `[]` when empty — the rule `owned_ids`, `authors` and
`retractable_in` already follow, so a client never has to tell "nobody has
left" from "this server does not say". A lesson id appears in at most one of
`authors` and `former_authors`, because an anonymized row has a NULL name and
`authorNames` emits no key for it.

On the single-lesson read it is a boolean beside `author_name`:
`"former_author": true`, always present.

A client renders "Former member" from it. The server never sends that string,
for the reason `authorNames` already states — it does not invent labels — and
because a literal in a name field cannot be told apart from a user who set
that as their actual name.

## Tests *(proposed)*

The ones carrying the most weight, each with its ablation:

- **An org-shared lesson survives its author's deletion, and the org can still
  read it.** Ablation: restore the unconditional cascade; the test must fail.
- **The org can still retract it afterwards.** This is the one that proves the
  feed reasoning. Ablation: delete the surviving author's `lesson_feed` rows
  before retracting, and the sequence allocation must break — which is the
  evidence that keeping them was load-bearing rather than incidental.
- **A public lesson and a private lesson by the same author are gone.**
- **A machine token belonging to the anonymized account no longer
  authenticates.** The security-critical one. Ablation: skip the
  `machine_tokens` delete and the test must fail.
- **The account cannot be logged into afterwards**, by its old email or any
  password.
- **A blocked author's block still applies** to their surviving org lesson,
  since blocks key on `author_key`. Guards the property named above.
- **The sole-owner refusal still fires, and leaves nothing half-dismantled** —
  memberships, tokens and lessons all still present after a 409.
- **Anonymizing twice changes nothing**, via `anonymized_at IS NULL`.
- **A lesson pushed between the decision and the write is not lost**: the
  delete path's added condition refuses rather than cascading it away. Drive it
  by seeding the lesson, then calling delete.
- Attribution: the surviving lesson reports `former_authors`, and a member who
  never set a name does not.

### Gates

Four, per this repo's standing correction after a PR passed every local gate
and failed CI:

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

Two of the fourth's checks bear on this work: the lesson-query boundary, which
keeps any new `lessons` query inside `db/lessons.ts` or `db/pool.ts` — and this
design deletes lessons from the account-deletion path, so that code belongs in
`db/lessons.ts` with a caller in `db/queries.ts`, not inline.

A fresh worktree must run `pnpm build` before `apps/api`'s suite, or every test
file fails to collect on `@onlooker-community/lesson-contract`'s missing entry.

Touching `packages/api-contract` means running both the `apps/api` and
`apps/web` suites.

## Deferred, each to its own issue

- **An org-level "make active".** A departed author's retracted lesson can
  never be made active again, because only the author's own route can do it and
  nobody can authenticate as that account. ONL-142 already filed this question;
  this design makes it reachable in one more way rather than creating it.
- **A lesson whose org is later deleted.** `lessons.org_id` is
  `ON DELETE SET NULL`, so such a lesson ends up readable by nobody at all —
  its author's disjunct belongs to an account nobody can use. Pre-existing for
  ordinary authors and newly permanent for anonymized ones.
- **Purging anonymized rows.** Nothing ever removes a `users` row whose last
  surviving org lesson is later retracted or deleted. A sweep could, and
  deciding whether it should is a retention question rather than this design's.
