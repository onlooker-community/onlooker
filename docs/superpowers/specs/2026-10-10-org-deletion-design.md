# Deleting an Empty Org — Design

Bead: `onlooker-px7ssn.2`, a child of
[ONL-136](https://linear.app/onlooker/issue/ONL-136). No Linear issue of its
own: it is a step of ONL-136 rather than work that outlives it.

PR #198 (`d2cb628`, on production since 2026-10-10) made account deletion
refuse while the account is the sole owner of any org. That closed a hole where
an org could be left with zero owners — a state no route can repair, and since
the org lesson tier opened, one where the org's lessons can never be retracted
either.

It also left a dead end. **An owner who is the only member of their org can no
longer delete their account by any route.** There is nobody to promote, and
there is no `DELETE /api/orgs/:id`. This specifies the way out.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-10-10.
Sections marked *(measured)* were read from this repository on 2026-10-10 and
name the file and line, so a reader can check rather than trust. Sections
marked *(proposed)* are this document's own recommendations.

## The trap, precisely *(measured)*

`deleteUser` (`apps/api/src/db/queries.ts:312`) folds its refusal into the
`DELETE`'s own `WHERE` clause, and `handleDeleteAccount`
(`apps/api/src/routes/account.ts:273`) turns that refusal into a
`409 sole_owner` carrying the blocking orgs in `error.details`, resolved by
`soleOwnedOrgs` (`apps/api/src/db/orgs.ts:403`).

Two populations hit that 409, and only one has a way out:

- **An owner of an org with other members** promotes somebody —
  `setMemberRole` permits it — and then deletes. The 409's message says exactly
  this: "An org needs an owner; promote somebody else first."
- **An owner who is the only member** has nobody to promote. The org routes in
  `apps/api/src/router.ts:404-497` are create, list, rename, members, invites
  and the lesson retract. There is no org delete. `REQUIRED_ROLE` in
  `apps/api/src/routes/orgs-authorization.test.ts:38-54` enumerates all twelve
  org routes and confirms it.

So the 409's advice is unfollowable for that account, and its account deletion
is unreachable. This is the state of the repo owner's own production org.

## What deleting an org already means *(measured)*

Four foreign keys reference `orgs`, and between them they already decide
everything that happens to an org's data. **The route needs no data handling of
its own.**

| references `orgs` | on delete | effect |
|---|---|---|
| `org_memberships.org_id` (`packages/db/src/schema.ts:432`) | cascade | memberships vanish |
| `org_invites.org_id` (`schema.ts:472`) | cascade | pending invitations vanish |
| `lessons.org_id` (`schema.ts:236`) | set null | lesson survives, unshared |
| `machine_tokens.org_id` (`schema.ts:141`) | set null | token survives, unbound |

The lesson case is the one worth stating carefully, because it is easy to get
backwards. A lesson left with `visibility = 'org'` and `org_id = NULL` is **not
invisible to its author.** `visibilityPredicate`
(`apps/api/src/db/pool.ts:135`) pushes `user_id = ?` as its own disjunct, so an
author reads their own lessons at any visibility and any status. What NULL
costs is everyone else: the org disjunct is `org_id IN (...)`, never true for
NULL. `schema.ts:236`'s own comment says so — NULL means such a row "matches
nothing for every reader including its author's org-mates."

That is the right end state. The lesson was shared with an org that no longer
exists; it reverts to its author alone, rather than being destroyed.

## Decisions *(approved)*

**D1. An org may be deleted only by an owner who is its only member.** Any
other member present means refusal.

The alternative — any owner, any time — is what most products do, and it was
rejected. ONL-12's design settled that a lesson shared with an org survives its
author's departure, because a team should not lose accumulated knowledge when
the person who had it leaves. Deleting a populated org destroys that sharing
for people who did not ask. Winding down a real team org therefore means
removing its members first, which is tedious and explicit, and each removal is
already a route.

This is a deliberate interim policy, not an oversight: populated-org deletion
is a consent question nothing is currently asking, and it gets its own issue
rather than a guess here.

**D2. The guard lives inside the `DELETE`'s `WHERE` clause.**

```sql
DELETE FROM orgs
 WHERE id = ?
   AND NOT EXISTS (SELECT 1 FROM org_memberships m
                    WHERE m.org_id = ? AND m.user_id != ?)
```

The org id binds twice rather than correlating on `orgs.id`, so the subquery
needs no outer reference.

A count-then-delete would be smaller and wrong, and here the race is concrete
rather than theoretical: **an invitee accepting between the read and the
write.** The read sees one member; the accept inserts a membership; the delete
then destroys an org somebody joined a moment earlier. With the guard inline,
the accept lands first and the `DELETE` matches no row. One statement is one
transaction in D1.

`db/orgs.ts` already records this reasoning for `removeMembership` and
`setMemberRole`, and `db/queries.ts:312` for `deleteUser`. This is the fourth
instance of a settled pattern, not a new invention — and leaving one of four
to a different shape is how the next reader concludes the other three were
special.

**D3. The refusal carries the member count and nothing else.**
`409 has_members`, `details: { member_count }`.

Not the members' names. The only page that renders this already lists them —
`OrgsPage` fetches members for every role (`apps/web/src/pages/OrgsPage.tsx:176`
and `:186`), so it can name them itself. That is the justification
`MachineTokenSummary.org_id` gives for carrying an id alone. Note this is the
opposite call from ONL-142's D2, where the same rule produced the opposite
answer because the lessons page had no other reason to fetch orgs. The rule is
"does the rendering page already hold it", not "ids are enough".

**D4. A second delete answers 404.** `requireOrgRole`
(`apps/api/src/orgs/authorize.ts:25`) throws one `404 not_found` for a null
principal, a non-member, and a non-owner alike, so an org that is already gone
is indistinguishable from one that was never the caller's. Deliberately unlike
#198, where an already-deleted account still reports `ok`: there the caller's
own identity was the target and "make it gone" was already satisfied. Here the
second call asserts something about a resource that is not the caller's to
assert.

**D5. The browser control is gated, not merely error-handled.** It renders only
when the viewer's role is `owner` and the loaded member list has exactly one
entry. `OrgsPage` already holds that list, so the gate costs no request.
`apps/web/src/pages/LessonDetail.tsx:318` records the principle: a button that
reliably fails is worse than no button, the API is the enforcement, and the
client only avoids offering what it will refuse.

**D6. The copy names what survives.** The surprising fact is not that the org
goes — it is that the lessons do not. The confirm text says the org is gone for
good, that lessons shared with it stay readable by you and by nobody else, and
that pending invitations are canceled.

`ConfirmAction` (`apps/web/src/components/ConfirmAction.tsx`), matching the
retract and revoke-invite controls rather than the delete-account flow's typed
email confirmation. By D1 the only member is the caller, so the blast radius is
the caller alone and a typed confirmation would be ceremony.

## The route *(proposed)*

`DELETE /api/orgs/:id`, `auth: "session"`, `cors: "app"`, owner-only, beside
`PATCH /api/orgs/:id` (`router.ts:418`).

- **200 `{ deleted: "<org id>" }`** on success. Not 204, and not
  `{ success: true }`: this surface already has two sibling deletes and they
  agree on a shape — `handleRemoveMember` answers `{ removed: params.userId }`
  (`apps/api/src/routes/orgs-members.ts:106`) and `handleRevokeInvite` answers
  `{ revoked: params.inviteId }` (`apps/api/src/routes/orgs-invites.ts:146`),
  each a 200 echoing the id it acted on. A third convention in one surface is
  worse than the marginally better REST of a 204.
- **409 `has_members`**, `details: { member_count }` — D3.
- **404 `not_found`** for a non-owner, a non-member, or an org that does not
  exist — D4, and `requireOrgRole` produces it unchanged.

## Server shape *(proposed)*

`deleteOrg(db, orgId, userId): Promise<"ok" | "has_members">` in
`apps/api/src/db/orgs.ts`, beside `soleOwnedOrgs`.

One statement, the D2 `DELETE`. On zero rows changed it resolves the ambiguity
with one follow-up count of the org's memberships:

- count > 1 → `"has_members"`, and the route answers 409 with the count.
- count 0 or 1 → the org was deleted concurrently, or never matched. The route
  answers 404, which is what `requireOrgRole` would have said a moment earlier.

The follow-up read is explanatory only, the same standing `soleOwnedOrgs` has:
the write has already decided authoritatively, and a drifting count can only
change which answer the caller reads, never whether a deletion happened.

The handler goes in `apps/api/src/routes/orgs.ts` with its siblings.

## Client shape *(proposed)*

- `apps/web/src/api/orgsApi.ts` — `deleteOrg(orgId)`, beside `renameOrg`.
- `apps/web/src/pages/OrgsPage.tsx` — a `ConfirmAction` in the org's own panel,
  gated per D5, copy per D6. On success, drop the org from the loaded list and
  clear the selection, so the page does not keep rendering a panel for an org
  that no longer exists.
- Errors reuse the page's existing `describeError` path. The 409 is reachable
  only by a race — a member joining between the page's load and the click — so
  its message is the server's, not a hand-written branch.

## Tests *(proposed)*

The one carrying the most weight: **an org with a second member refuses.** Its
ablation is deleting the `NOT EXISTS` clause, after which that test must fail.
The fixture needs a genuine second `org_memberships` row — this project's
signature defect across ONL-141 and ONL-142 was a test that could not fail
because its fixture never reached the state the guard existed for, eight times
between them, and every instance was caught by ablation rather than by reading.

Beyond that:

- The sole-member success: the org is gone, and `GET /api/orgs` no longer
  lists it.
- The cascades and the set-nulls, asserted rather than assumed: after deleting
  an org, its memberships and invites are gone, while a lesson that was
  `visibility = 'org'` in it still exists with `org_id = NULL`, and its author
  can still read it. That last assertion is the one to insist on: "the schema
  already handles the lessons" is this design's reason for the route touching
  no lesson at all, and it is a claim about behavior, so it gets a test rather
  than a sentence.
- `DELETE /api/orgs/:id` added to `REQUIRED_ROLE` as `"owner"`. The matrix's
  "has no untracked routes" test fails until it is, which is the guard working.
  The owner case must be exercised against a **real** org id: ONL-141 found
  this matrix could pass a route with no role check at all, because
  `concrete()` used a nonexistent id and the handler's own 404 masked the
  missing guard. A member attempting the delete must get 404, and that test's
  ablation is removing the `requireOrgRole` call.
- The end-to-end acceptance criterion as one test: a sole owner of a
  single-member org deletes the org, then deletes their account, and the second
  call succeeds where it previously returned 409.
- Contract: `DELETE /api/orgs/:id with no credential` → 401, beside the other
  `ORG_LIFECYCLE` cases, which are all unauthenticated-shape cases
  (`packages/api-contract/src/index.ts:640`). Mock taught.
- Web: the control renders for a sole owner, not for a member, and not for an
  owner whose org has two members; a successful delete removes the org from the
  list.

### Gates

Four, per this repo's standing correction after a PR passed every local gate
and failed CI:

1. `pnpm --filter <pkg> test`
2. `pnpm --filter <pkg> typecheck`
3. `pnpm --filter <pkg> lint`
4. `bash scripts/source-guards.test.sh`

The fourth is wired into no pnpm script and runs as a bare bash step in
`.github/workflows/deploy.yml`. Touching `packages/api-contract` means running
**both** the `apps/api` and `apps/web` suites.

A fresh worktree must run `pnpm build` before `apps/api`'s suite: without it
every test file fails to collect on `@onlooker-community/lesson-contract`'s
missing entry, and with a stale `packages/db/dist` the org tables import as
`undefined`. CI never sees either, because it builds before testing.

## Deferred, each to its own issue

- **Deleting a populated org.** The consent question D1 declines to guess at:
  may one owner end an org for everybody, and if so what are the other members
  told?
- **A stranded lesson keeps its `'org'` label.** After its org goes, a lesson
  reads `visibility = 'org'` while behaving as private, and no route can
  relabel it — the browser transitions status only. Cosmetic today, misleading
  the moment anything renders that label as "shared".
- **Surfacing the 409 in the delete-account flow** is `onlooker-px7ssn.5`,
  already its own bead: the API names the blocking orgs in `error.details` and
  the settings page shows only the message. That bead is what makes this one
  discoverable; this one is what makes that bead's advice followable.
