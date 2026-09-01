# Lesson Activity Screen — Design

Bead: `onlooker-6w8`. Applies to `apps/api`, `apps/web`, and
`packages/api-contract`.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-08-31 and are
decisions rather than proposals. Facts about the current codebase were verified
against `main` at `73f6732` on that date.

## Boundary *(approved)*

**In scope:** a read-only `/activity` screen, one new session-authenticated
`GET /api/activity` endpoint, the `listActivityPage` query beside the existing
`listLessonsPage`, an `api-contract` entry, and a fifth `AppShell` nav slot.

**Out of scope:** any change to `lesson_feed`'s columns, the machine-authenticated
sync routes, and the two rejected screens described below.

---

## The gap *(approved)*

`lesson_feed` is written on every lesson create and every status transition. It
carries a per-user sequence and is read by exactly one consumer: the CLI's delta
sync. The web app cannot reach it at all — `/lessons` (unprefixed) is the
machine-authenticated sync surface, `/api/lessons*` is the browser surface, and
no browser route touches the feed.

So the app cannot answer a question it has the data for. `/lessons` shows what a
lesson **is**. Nothing shows when it changed, in what order, or that it changed
at all. A lesson retracted last Tuesday and one never touched render identically.

### Why not derive this from what the web app already fetches

`created_at` and `promoted_at` on a lesson row describe current state with dates
attached. They cannot express a transition the current row no longer reflects —
which is exactly what the feed records. Deriving would have avoided all API and
contract work and surfaced none of the data this screen exists to show.

### Two other candidates, rejected on evidence

**Active sessions.** The `sessions` table stores `id`, `user_id`, `token_hash`,
`expires_at`, `created_at`. No user agent, no IP, no last-seen. A row could only
say "created Aug 30, expires Sep 6", so the screen would need new columns before
it could say anything a person recognizes.

**Client errors.** `POST /api/client-errors` writes to `console.warn` and the
Workers log, not to a table. The GitHub Action monitors those logs. There is
nothing to query without building storage first.

---

## API *(approved)*

New session-authenticated `GET /api/activity`. Reads `lesson_feed` for the
signed-in user, joined to `lessons`. Each row returns `seq`, `kind`
(`"create" | "status"`), `at`, `lesson_id`, and from the joined lesson: `claim`,
`applies_to`, `status`.

`claim` rather than a title, because `lessons` has no title column — the UI
already identifies a lesson by `lesson.claim`, parsed from `body`.

### Ordered by `seq DESC`, not `at DESC`

`seq` is the feed's own per-user sequence and is unique by index
(`lesson_feed_user_seq_idx` on `user_id, seq`). `at`'s `CURRENT_TIMESTAMP`
default is not actually in play: both writers of `lesson_feed`
(`createLessonsWithFeed` and `transitionLesson` in `apps/api/src/db/lessons.ts`)
bind an explicit ISO timestamp instead of relying on it, and
`createLessonsWithFeed` binds that SAME timestamp to every row of a batch — so
a tie is not merely possible, it is guaranteed within a batch. A tie in the
sort key gives an unstable order across page boundaries, which is how cursor
pagination silently drops or repeats rows.

### Pagination

`listActivityPage(db, userId, { cursor, limit })`, in
`apps/api/src/db/lessons.ts` beside `listLessonsPage`, reusing
`BROWSE_DEFAULT_LIMIT` (50) and the existing `InvalidCursorError`. The cursor is
a `seq`.

Same file and same conventions on purpose: this is the second read over the same
feed the browse routes already page through, and a second pagination idiom in
one codebase is a maintenance cost with no benefit.

---

## The limitation this screen has to live with *(approved)*

`kind: "status"` records **that** a status changed, not to what. `lesson_feed`
has no `from` or `to` columns.

So a status row reads "status changed" and does not name a state. The row
shows no status at all — not the state it changed to, and not the lesson's
current state either.

**A clause to show the lesson's current status next to the event was approved
and then dropped on 2026-08-31**, after the whole-branch review found it
unimplemented. The reasoning: "Status changed · `<claim>` · retracted" in a
single row reads as though the event itself set the status to retracted — the
exact inference the first sentence above exists to prevent. Adjacency defeats
the separation. A lesson's current status is already visible on `/lessons` and
on the lesson itself, so the screen loses nothing by leaving it off the event.

This is deliberate and it is the conservative reading. Naming the current status
on a past event would be actively wrong for any lesson that changed twice: a
lesson retracted in March and reinstated in April would show both events labeled
"active". A vague row is worse than a precise one and much better than a
confident lie.

**The alternative, not taken:** add `from`/`to` columns to `lesson_feed`. That is
a schema migration plus a contract bump, and it turns a screen into a data-model
change. It should be its own bead if the vaguer row proves unsatisfying in use,
rather than speculative work now.

---

## Screen *(approved)*

`/activity`, wrapped in `AppShell` **in the route**, matching how all four
authenticated routes work after `onlooker-e5a`. The page component stays plain.

A fifth entry in `AppShell`'s `SECTIONS`, with the `Book` icon — the log-shaped
one in the brand set not already taken by `ChestTreasure` (lessons), `Key`
(machines), `Gear` (settings) or `CatHead` (profile).

One `Panel` per day, titled with the date, events inside. `EmptyState` when the
feed is empty — the common case for a new account, and it deserves written copy
rather than a blank panel.

## Contract *(approved, corrected 2026-08-31)*

`packages/api-contract` gains cases for the endpoint: the unauthenticated `401`
in `anonymousCases()`, and the authenticated `200` with its expected shape in
`authenticatedCases()`.

**No version bump, and the earlier draft of this section was wrong to ask for
one.** It claimed CI's `contract-version` job would fail a pull request that
changed the contract without a bump. That job guards
`packages/lesson-contract/schema/` — the published npm package defining a
*lesson's* shape — and compares `packages/lesson-contract/package.json`'s
version. `packages/api-contract` is a different thing entirely: an internal
test-fixture library exporting `anonymousCases`, `authenticatedCases` and
`shapeFailures`, with no version field and no CI guard.

This work adds an HTTP endpoint. It touches neither the lesson schema nor its
package version, so the guard is not involved and nothing needs bumping. The
contract cases are still worth adding — they are how a response-shape change
fails a test rather than surprising the browser — but they are ordinary test
coverage, not a release gate.

## Testing *(approved)*

**Query.** `listActivityPage` returns a stable order when two rows share the same
`at` — the case that motivates ordering by `seq`. Cursor round-trip returns the
next page without dropping or repeating a row. User isolation: one user's call
never returns another user's feed rows.

**Route.** 401 when unauthenticated. Response shape matches the contract entry.

**Web.** Events group under day headings. The empty state renders on an empty
feed.

The user-isolation test is the one that matters most: the feed is per-user by
`user_id` and the join is the place a missing predicate would leak another
account's claims.

## Rollback

One commit touching two apps and one package. `git revert` restores it; nothing
here migrates data, changes existing endpoints, or alters what sync reads.

## Open questions

None blocking. Whether `lesson_feed` should record `from`/`to` is a real
question and deliberately deferred — see the limitation section.
