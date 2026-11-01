# Deleting Revoked Machines — Design

Linear: ONL-231.

**A person can delete a revoked machine from the Machines page. It leaves that
page and nothing else: its row stays, marked `removed_at`, so its session
history survives.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-01.
Sections marked *(measured)* were read from this repository on 2026-11-01.

## The problem *(measured)*

A revoked machine keeps its row on the Machines page forever, with no action
left on it (`MachinesPage.tsx`, `action` returns null). Old tokens pile up.

A real delete is not free:

* `session_summaries.machine_id` is `ON DELETE CASCADE`, so deleting the token
  row erases every session that machine reported. Revoking keeps them on
  purpose.
* `project_labels.machine_id` has no foreign key, so a root-key label would be
  left behind.
* The Sessions page reads `GET /api/machines` to name the machine a session came
  from (`machineName`), and to pick its empty state (`hasSynced`, where revoked
  machines deliberately count).

## Decisions *(approved)*

**Keep the history.** "Delete" removes the machine from the Machines page and
keeps its row, sessions and labels. Rejected: a hard delete, which loses history
that cannot be recovered and lowers usage totals; and collapsing revoked rows
into a section, which leaves them there forever.

**Only a revoked machine can be removed,** so a live credential cannot vanish
from the page while it still works.

## Data

A nullable `removed_at` text column on `machine_tokens`, in one migration. Null
means the machine shows on the page. Set once, and never cleared: there is no
undo in this slice.

`verifyMachineToken` does not change. A removed token is always revoked, so it
already cannot authenticate.

## API

`POST /api/machines/:id/remove`, session-authenticated like revoke. Not
`DELETE /api/machines/:id`, which already means revoke.

`removeMachineToken(db, userId, id)` sets `removed_at` on a row that matches all
of: this id, this user, `revoked_at` not null, `removed_at` null. It answers
whether a row changed.

* Success: `200 { "success": true }`.
* Anything else: `404 not_found` "No such machine". A live machine, someone
  else's, one already removed and one that never existed all answer the same,
  as revoke's 404 does.

## Listing

`GET /api/machines` keeps returning removed rows, with `removed_at` added to
each. `MachinesPage` filters them out. If the API dropped them, an old session
would read "unknown machine", and someone whose only machine was removed would
be told nothing had synced. The Sessions page does not change.

## The page

* A revoked row gets a `ConfirmAction`: trigger "Delete", question
  `Delete <name>? Its sessions stay.`, confirm "Yes, delete", pending
  "Deleting...", variant `danger`.
* On success the row is gone. Focus moves to the next visible row, or the
  previous one when the deleted row was last, and the always-mounted status
  region reads `Deleted <name>.` Focus falls back to the status region when no
  row is left or the reload failed and took the rows with it.
* While a token reveal is open, the announcement is parked and flushed the way
  revoke's is, because the page is inert underneath the reveal.
* On failure, the error shows where a failed revoke's does and focus does not
  move. The list reloads, so a row already removed elsewhere does not stay and
  answer 404 on every retry; otherwise the row stays.
* With every machine removed, the page shows its existing empty state.

## Tests

API, against D1:

* Removing a revoked machine sets `removed_at`, and the list still returns it.
* A live machine, another user's, an already-removed one and an unknown id each
  answer 404 and write nothing.
* A removed machine's sessions survive.

Web:

* A revoked row offers Delete and a live row does not.
* Deleting removes the row and announces it. Focus lands on the next row, on
  the previous row when the last one was deleted, and on the status region when
  no row remains or the reload fails.
* A failed delete keeps the row and shows the error, and reloads the list.
* An announcement waits while a reveal is open.
* The Sessions page still names a removed machine.

`mockApi` gets the same behavior, and the contract tests cover the route.

## Docs

None beyond this file. No document describes the Machines page's actions.

## Deferred

* Undoing a delete.
* Hard-deleting a removed machine's data. Account deletion already covers its
  rows.
