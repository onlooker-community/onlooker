# Org Retract UI — Design

Bead: `onlooker-6uivte` ([ONL-142](https://linear.app/onlooker/issue/ONL-142)),
filed out of the whole-branch review of
[ONL-141](https://linear.app/onlooker/issue/ONL-141), which shipped the org
lesson tier (PR #196, deployed 2026-10-09).

`POST /api/orgs/:id/lessons/:lessonId/retract` exists, is owner-only, scoped to
the org in its path, tested, and verified against production. **Nothing in the
browser calls it.** `LessonDetail`'s status control renders only when
`own === true`, so an org lesson a teammate wrote never offers one. This
specifies the browser half.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-10.
Sections marked *(measured)* were read from this repository on 2026-10-10 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## Why this is not just a missing button *(approved)*

D6 of the org visibility design states the purpose:

> The org-level retract keeps that from making the operator the moderation
> queue for every customer.

That holds only once an owner can reach it. Until then an org wanting a lesson
taken down has exactly one route — ask the operator — which is the thing D6
exists to prevent.

## What exists today *(measured)*

**The detail pane already asks the server what it may act on.**
`apps/web/src/pages/LessonDetail.tsx:199-201` derives `own` from `ownedIds` for
a listed lesson and from `fetchedOwn` for one only that pane holds, defaulting
to false because "an unknown owner renders no control rather than one that
404s". `authorName` (`:208-210`) follows the identical split, for the stated
reason that the two sources do not overlap: a deep-linked lesson is on no
loaded page, and a filter refetch can empty the page's state while the pane
still shows a lesson out of `fetched`.

**The status control's gate records the principle this design follows.**
`LessonDetail.tsx:318`:

> Gated on ownership too. The pool shows other people's public lessons, but
> transitionLesson is still `WHERE id = ? AND user_id = ?`, so this control on
> somebody else's lesson can only 404 [...] a button that reliably fails is
> worse than no button. apps/api is the enforcement; this only avoids offering
> what it will refuse.

**The pool read already has most of the ingredients.**
`apps/api/src/db/pool.ts` selects `body, user_id, visibility, org_id`, resolves
the reader's orgs for the predicate, and computes an `orgReached` set — the
rows that arrived through the org disjunct — to decide attribution.

**What it has not got is role.** `OrgIds`
(`apps/api/src/db/orgs.ts`, via `orgIdsForUser`) returns org ids and nothing
else, because that is all the visibility predicate may key on.

**The retract is one-way.** `retractOrgLesson`
(`apps/api/src/db/lessons.ts`) delegates to
`transitionLesson(db, stored.user_id, lessonId, "retracted", null)`. There is
no org-level route back to `active`; only the author's own transition route can
do that.

**`ConfirmAction` already exists** (`apps/web/src/components/ConfirmAction.tsx`)
and takes `trigger`, `question`, `confirmLabel`, `onConfirm`, `pending`,
`variant`, `pendingLabel`, `resetToken`.

## Decisions *(approved)*

**D1. The server names the org you may retract in; the browser does not work
it out.** The pool read gains a sidecar mapping lesson id to the org through
which the viewer may retract that lesson, populated only where the viewer's
role in that org is `owner`.

The alternative was exposing `org_id` per lesson and having the page pair it
against `GET /api/orgs`, which already returns the caller's role per org. That
was rejected because it puts an authorization judgment in the browser, and
`ownedIds` exists in this codebase specifically because that judgment belongs
to the server. It also would not be cheaper in requests — see D3.

**D2. The sidecar carries the org's NAME as well as its id**, as
`{ org_id, org_name }`.

This deviates from the nearest precedent and the deviation is deliberate.
`MachineTokenSummary.org_id` is an id alone, justified in
`apps/api/src/db/machine-tokens.ts` by "the only page that renders this already
lists the account's orgs to offer the picker, so it can resolve the name
itself". That justification does not hold here: the lessons page does not fetch
orgs and has no other reason to. Making it fetch the whole org list to render
one label is worse than a second statement against `orgs` for the one or two
ids a page actually needs.

**D3. The owner-org resolution is lazy.** It runs only when a page carries at
least one org-reached row, which `orgReached` already determines for
attribution. An ordinary private-or-public browse therefore makes exactly the
queries it makes today.

Same shape and same reasoning as the push gate's conditional token-org
resolution in `apps/api/src/routes/lessons.ts`: do not charge every request for
something only a minority of requests need.

**D4. A separate resolver, not a widened `OrgIds`.**
`ownerOrgIdsForUser(db, userId)` is its own function. `OrgIds` feeds the
visibility predicate, which must stay keyed on membership; a role in that bind
path has no business being there, and conflating the two questions is how a
later change puts one in the wrong place.

**D5. The control names the org and says the retraction is one-way.** The
confirm copy states that the lesson belongs to someone else, that it will stop
being readable by the org, and that only its author can make it active again.

The author's control is a bidirectional Retract/Make-active pair. This one is a
one-way door across an ownership boundary, and a person should learn that
before clicking rather than after.

**D6. Author wins over owner.** A viewer who is both the lesson's author and an
owner of its org gets the ordinary author control; this one stays hidden. It is
strictly more capable, and two controls on one lesson is worse than one.

**D7. Detail pane only.** The list rows carry status badges, not controls, and
the author's retract is detail-only. This follows that.

## The response shape *(proposed)*

`GET /api/lessons` gains, beside `lessons`, `cursor`, `has_more`, `owned_ids`
and `authors`:

```json
"retractable_in": {
  "01KZ...": { "org_id": "82bd...", "org_name": "Onlooker Community" }
}
```

`GET /api/lessons/:id` gains:

```json
"retractable_in": { "org_id": "82bd...", "org_name": "Onlooker Community" }
```

or `null`.

Always present, `{}` or `null` when nothing qualifies — the rule `owned_ids`
and `authors` already follow, so a client never has to tell "nothing is
retractable" from "this server does not say".

A key appears only when **all** of these hold: the row reached this reader
through the org disjunct, its `org_id` is one the reader belongs to, and the
reader's role in that org is `owner`.

Two consequences of that wording, stated so a reader need not derive them. A
lesson whose org was deleted has a NULL `org_id` — `lessons.org_id` is
`ON DELETE SET NULL` — so it is not org-reached, gets no entry, and offers no
control; it is also unreadable by then, so there is nothing to retract. And a
lesson the reader reaches *only* by having authored it, in an org they have
since left, gets no entry either: they are no longer a member, let alone an
owner.

## Server shape *(proposed)*

`ownerOrgIdsForUser` goes in `apps/api/src/db/orgs.ts` beside
`orgIdsForUser`, filtered on `role = 'owner'`, ordered by id for a stable bind
order, reading `org_memberships` through `org_memberships_user_id_idx`.

Bounded by `MAX_READER_ORGS_BOUND` for consistency with the predicate rather
than out of necessity: this list feeds an in-memory membership check and a
names query over the one or two ids a page actually carries, so it is nowhere
near D1's parameter cap. The bound is there so the places that consume a
reader's org list agree on one shape, not because this one would otherwise
break.

The names come from a second statement against `orgs` for the distinct ids
involved, inside `pool.ts`, the way attribution resolves author names — rather
than a join, which would change the measured query plan that
`pool-query-plan.test.ts` pins. One or two ids, and it runs only when something
is retractable.

`getLessonForUser` resolves the reader's orgs once already; it gains the owner
check on the same path, and only for a lesson that is org-reached.

## Client shape *(proposed)*

- `apps/web/src/api/lessonsApi.ts` — the two fields on `LessonPage` and
  `OwnedLesson`, plus `retractOrgLesson(orgId, lessonId)`.
- `apps/web/src/pages/LessonsPage.tsx` — `retractableIn` held beside
  `authors`, merged on "load more" the same way and defaulted with `?? {}` on
  read, exposed on `LessonsContext`.
- `apps/web/src/pages/LessonDetail.tsx` — derived with the same listed/fetched
  split as `authorName`, for the same reason. A second `ConfirmAction`,
  rendered only when `!own` and a `retractable_in` entry exists. On success,
  `patchLesson(id, "retracted")`, so the row and the pane agree without a
  refetch.

## Errors *(proposed)*

Reuse `LessonDetail`'s existing `actionError` shape, which already carries a
`retryable` flag:

- **404** — not retryable. The lesson is no longer this org's to retract, or
  never was. Indistinguishable from "no such lesson" by design, so the copy
  must not claim to know which.
- **503 `sequence_contention`** — retryable, the same treatment the author path
  already gives it. Nothing was written when it fires.

## Tests *(proposed)*

The one that carries the most weight: **a member of the same org gets no
entry.** Its ablation is dropping the `role = 'owner'` filter from
`ownerOrgIdsForUser`, after which a member must see one. This stage's
predecessor found four tests that could not fail, every one an inadequate
fixture rather than a redundant guard, so the fixture here needs a real member
and a real owner in the same org, with a lesson authored by a third account.

Beyond that:

- An owner gets an entry for a teammate's org lesson, carrying the right org id
  and name.
- No entry for the reader's own lesson, in an org they own — D6.
- No entry for a public or private lesson, however the reader is related to it.
- `retractable_in` is present and empty for a page with no org rows, and the
  owner query does not run — D3, observed rather than assumed.
- The single-lesson read answers for both a listed and a deep-fetched lesson,
  which is the split that shipped untested in ONL-141 and had to be fixed
  after review.
- Web: the control renders for an owner on a teammate's lesson, not for a
  member, not for the reader's own; the confirm copy carries the org name and
  the one-way sentence; a successful retract patches the row.
- Contract: both fields pinned, mock taught. The retract route already has a
  401 case from ONL-141's fix wave; it now needs the authorized shape too.

### Gates

Four, per this repo's standing correction after a PR passed every local gate
and failed CI:

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

The fourth is wired into no pnpm script and runs as a bare bash step in
`.github/workflows/deploy.yml`. Two of its checks bear on this work: the
lesson-query boundary, which keeps any new `lessons` query inside
`db/lessons.ts` or `db/pool.ts`, and the `apps/web` loading-state check.

Touching `packages/api-contract` means running **both** the `apps/api` and
`apps/web` suites.

## Deferred, each to its own issue

- **An org-lesson list on the Orgs page**, so an owner could moderate without
  browsing the pool. The natural home for it, and a different feature.
- **An org-level "make active".** The API deliberately has none; adding one is
  a decision about whether an owner may reverse a teammate's own retraction,
  which is not this issue's to make.
- **Cross-member verification on production.** Still unverified from ONL-141:
  the only org on production has a single member, and seeding a second
  requires a readable mailbox because membership is by invitation and
  deliberately not operator-seeded. Unchanged by this work.
