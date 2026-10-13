# Saying What Account Deletion Will Destroy — Design

Bead: `onlooker-px7ssn.4`, the last child of `onlooker-px7ssn`
([ONL-136](https://linear.app/onlooker/issue/ONL-136)). Its three siblings have
shipped: deletion refuses while you are an org's sole owner (PR #198), a sole
member can delete the org itself (PR #199), org-shared lessons outlive their
author (PR #200), and the web flow names the orgs behind a refusal (PR #201).

**Before a deletion runs, the flow says how many public lessons it will destroy
and which orgs keep theirs.** Today the panel says only that "Lessons you
shared with an org stay with that org; everything else goes"
(`apps/web/src/pages/SettingsPage.tsx:359`) — true, and silent about scale.
Somebody with sixty published lessons and somebody with none read the same
sentence, and the first one finds out from a dead link.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-12.
Sections marked *(measured)* were read from this repository on 2026-10-12 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## What is already true *(measured)*

**The public-tier semantics are already written down.** D2 of
`docs/superpowers/specs/2026-10-11-org-lesson-inheritance-design.md` states that
`visibility = 'org'` rows with a non-null `org_id` survive and that public and
private lessons are deleted with the account, with the rationale: "a public
lesson's readers are not a team, and publishing to the world then closing the
account reads as a withdrawal."

This closes half of the bead's acceptance criteria on its own. The parent's
Done-when asked that the public-tier answer be "stated explicitly rather than
inherited from a schema default", and D2 is that statement. This document does
not restate it and does not revisit it.

**The disclosure was assigned to the wrong sibling.** D5 of that same spec put
"naming *which* orgs and *how many* lessons" with `onlooker-px7ssn.5`, whose own
acceptance criteria never mentioned it. PR #201 shipped `.5` as written — the
sole-owner 409 — so the disclosure fell between the two beads and is the work
remaining here.

**Deletion's own split is one condition, negated.** `hasOrgSharedLessons`
(`apps/api/src/db/lessons.ts:704`) asks for `visibility = 'org' AND org_id IS
NOT NULL`; `nonOrgLessonsDelete` (`:743`) deletes `NOT (...)` of the same
condition, and its comment says the negation is deliberate "so the two cannot
drift apart". A preview is a third reading of that split and inherits the same
obligation.

**Retraction already hides a lesson across the ownership boundary.**
`apps/api/src/db/pool.ts:160` adds `status != 'retracted'` to every disjunct
that is not the caller's own rows, under the rule stated at `:104` — "your own
lessons you see at any status, but across an ownership boundary" they do not.
`lessons.status` is a plain `notNull` text column (`packages/db/src/schema.ts:208`),
so nothing else enforces this.

**Lesson queries are confined to two files.** The source guard at
`scripts/source-guards.test.sh:172-201` fails any lesson or `lesson_feed` query
outside `db/lessons.ts` and `db/pool.ts`, and its matcher recognizes raw SQL and
drizzle builder calls alike (`:75-78`). A new counting query has one legal home
without amending the guard: `db/lessons.ts`, beside the two helpers above.

**The account family answers in camelCase.** `accountUser`
(`apps/api/src/routes/account.ts:53-64`) emits `createdAt` and `emailVerified`,
while the lessons routes emit `has_more` (`apps/api/src/routes/lessons.ts:607`).
The two conventions coexist by route family, so a new account route follows
account.

## Decisions *(approved)*

**D1. The preview is fetched when deletion is asked for, not when the page
loads.** `GET /auth/account/deletion-preview`, called as the panel enters its
confirming state.

Two reads on every `/settings` visit would be paid for by every visitor, almost
none of whom are leaving, and the numbers would describe the moment the page
loaded rather than the moment they are read. Folding the counts into
`GET /auth/profile` was the alternative and loses on both counts.

**D2. The counts include only what somebody else can currently read.**
`status != 'retracted'` on both statements.

A retracted public lesson is already withdrawn — `pool.ts:160` hides it from
everybody but its author — so counting it among what deletion destroys
overstates the loss, and telling somebody an org "keeps" a lesson that org
cannot read is worse than saying nothing. `superseded` rows stay counted: the
pool serves those with their status attached, so they are still readable.

**D3. Public lessons are counted; private ones are not.** Both are deleted.

Disclosure exists for content other people can see. A private lesson has no
audience to lose it, and would be unreadable by anyone in any case once nobody
can authenticate as its author — the reasoning `nonOrgLessonsDelete`'s comment
already gives. The standing sentence's "everything else goes" covers them.

**D4. Each org is named, with its own count, ordered by name.** Not a single
total.

The same reasoning PR #201 shipped for the 409: somebody who belongs to several
orgs learns nothing actionable from a number. `ORDER BY o.name` matches
`soleOwnedOrgs` (`apps/api/src/db/orgs.ts:417`), so the two lists a person may
see minutes apart are ordered the same way.

**D5. A failed preview says so and does not block deletion.**

Closing your own account should not depend on a disclosure query succeeding, and
the irreversible case is already guarded: #198's 409 refuses while an org would
be left ownerless, whatever the preview did. Blocking on failure would let a
transient 500 strand somebody in an account they have decided to leave.

## The API surface *(proposed)*

One route, registered beside `DELETE /auth/account`
(`apps/api/src/router.ts:179-184`) with the same `auth: "session"` and
`cors: "app"`:

```
GET /auth/account/deletion-preview

{ "publicLessons": 12,
  "orgsKeeping": [ { "id": "org-1", "name": "Acme", "lessons": 4 },
                   { "id": "org-2", "name": "Beta",  "lessons": 1 } ] }
```

`accountDeletionPreview(db, userId)` in `apps/api/src/db/lessons.ts` runs two
statements and returns `{ publicLessons, orgsKeeping }`:

```sql
SELECT COUNT(*) AS n FROM lessons
 WHERE user_id = ? AND visibility = 'public' AND status != 'retracted';

SELECT o.id AS id, o.name AS name, COUNT(*) AS lessons
  FROM lessons l JOIN orgs o ON o.id = l.org_id
 WHERE l.user_id = ? AND l.visibility = 'org'
   AND l.org_id IS NOT NULL AND l.status != 'retracted'
 GROUP BY o.id, o.name ORDER BY o.name;
```

The second statement's `visibility`/`org_id` pair is `hasOrgSharedLessons`'s
condition verbatim, and the first is a narrowing of `nonOrgLessonsDelete`'s
complement — public rather than every non-org row, per D3. A reader comparing
the three should find the same split each time.

No schema change, no migration, no new binding, so
`ENVIRONMENT_VARIABLES.md` and its guard are untouched.

## The panel *(proposed)*

`DeleteAccountSection` gains one state union — `idle | loading | ready |
unavailable` — alongside the `refusal` state PR #201 added
(`SettingsPage.tsx:327`). Clicking "Delete my account" sets `confirming` as it
does now and starts the fetch. The confirm button's `disabled` stays bound to
the typed-email check alone, in every state, which is D5 expressed in code.

Copy:

- **ready, with content:** "Deleting this account will destroy **12 public
  lessons**. Anyone holding a link loses it. **5 lessons stay with their org:**
  Acme (4), Beta (1)." The 5 is summed on the client from `orgsKeeping`; the
  API sends no total, because a total the server computes and a total the names
  add up to are two numbers that can disagree.
- **ready, nothing shared:** "You have no shared lessons, so nothing published
  will be lost."
- **loading:** "Checking what deletion will remove…"
- **unavailable:** "Couldn't check what deleting will remove. Your account can
  still be deleted."

The `unavailable` sentence is deliberately two clauses: the first is honest
about the gap, and the second forestalls reading the gap as a refusal — the
mistake the sole-owner message exists to prevent in the other direction.

The mock serves this route too, unlike the 409 `.5` could not reproduce: a
static preview needs no ownership modeling, so mock-mode development sees the
real states rather than `unavailable` forever. This is the narrow case where
`mockApi` can hold up its end; the broader divergence stays with
`onlooker-jws`.

## Tests *(proposed)*

- `apps/api/src/db/lessons.test.ts` — the two statements: grouping by org,
  retracted rows excluded from both counts, another user's rows excluded, a
  `superseded` row still counted, and an org lesson absent from the public
  count.
- the route — `auth: "session"` enforced, and the response shape.
- `apps/web/src/api/accountApi.test.ts` — the client maps the payload, and a
  failure rejects rather than resolving to zeros, which would be indistinguishable
  from an account that has published nothing.
- the panel — counts rendered on intent, the empty sentence when there is
  nothing shared, the `unavailable` sentence on failure, and **confirm still
  enabled after a failure**, which is the D5 guard and the one worth proving by
  ablation.
- `apps/web/src/api/api-contract.test.ts` — the new endpoint, so the mock and
  the API cannot answer it differently.

### Gates

Four, per the lesson of PR #188: `pnpm --filter <pkg> test`, `typecheck`,
`lint`, and `bash scripts/source-guards.test.sh` — the last wired into no pnpm
script and therefore invisible to any local sweep that does not name it. The
boundary guard at `:172-201` is the one this design is most likely to trip, and
it should pass unamended; if it fails, the query is in the wrong file rather
than the guard being wrong.

## Deferred, each to its own issue

- **CLI and API callers get no preview.** `DELETE /auth/account` is reachable
  without the browser and answers nothing about what it will remove. The
  endpoint added here is available to them, but nothing makes them call it.
- **The preview can disagree with the deletion.** A lesson pushed between the
  two requests is counted wrongly, by one, in a disclosure nobody is relying on
  for exactness. Making them agree means reading and deleting in one
  transaction, which the deletion path deliberately does not do (its own
  comment at `lessons.ts:743` explains why the statement is handed to a batch).
- **Private lesson counts.** D3 leaves them uncounted. If a person ever asks
  "how much of my own work goes", that is a different disclosure with a
  different audience.
