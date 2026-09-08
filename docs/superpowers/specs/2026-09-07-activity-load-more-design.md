# Activity Feed Pagination — Design

Bead: `onlooker-58i`. Applies to `apps/web` only. No API, schema, or contract
change.

Follow-on to `2026-08-31-lesson-activity-screen-design.md`, which built the
endpoint's pagination and then shipped a screen that never called it. Raised by
the whole-branch review of `onlooker-6w8` and deliberately deferred there:
adding a load-more control is a decision about what the screen should do at
volume, not a defect in what it does today.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-09-07 and are
decisions rather than proposals. Code references were read on this machine on
2026-09-07 at `6c0c45d`.

## Boundary *(approved)*

**In scope:** a load-more control on `/activity`, a `listActivity` client
function, and the test rewiring both require.

**Out of scope:** the API, the query, the contract, `mockApi`'s feed, and the
shared-hook extraction `onlooker-bcn` owns. Each is argued below rather than
merely listed.

## The gap *(measured)*

`GET /api/activity` is cursor-paginated end to end and the screen ignores it.

| Layer | State |
|---|---|
| `listActivityPage` (`apps/api/src/db/lessons.ts:452`) | takes `cursor` and `limit`, orders `f.seq DESC`, pages on `f.seq < ?`, returns `cursor` and `hasMore` |
| `handleActivity` (`apps/api/src/routes/activity.ts`) | forwards all three, returns `events`, `cursor`, `has_more` |
| `ActivityPage.tsx` | **declares `cursor` and `has_more` on its response interface and reads neither** |

Past `BROWSE_DEFAULT_LIMIT` (50, `apps/api/src/db/lessons.ts:363`) a person sees
the newest 50 events, with no control to reach older ones and nothing on screen
indicating more exist.

This is not a regression — the screen has never paginated — and not a spec
violation, since the Screen section of the prior design never asked for
pagination. It is pagination with no consumer.

## Decision: paged by count, not windowed by date *(approved)*

The bead offered date-windowing as an alternative, on the reasonable ground that
the screen groups by day, so a feed windowed by date would match what a reader
already sees.

Rejected, on the prior spec's own principle. Its Pagination section chose to
reuse `BROWSE_DEFAULT_LIMIT` and the existing `InvalidCursorError` because "a
second pagination idiom in one codebase is a maintenance cost with no benefit."
Windowing by date needs an `at`-bounded query beside the existing `seq` cursor,
which is that second idiom, at the API layer the prior spec deliberately kept
single.

The third branch the bead allowed — record the cap as deliberate and ship
nothing — was declined because it leaves a reader past 50 events with no signal
that older ones exist. That is the part worth fixing.

## Section 1 — `listActivity` joins `lessonsApi` *(approved)*

```ts
export interface ActivityEvent { seq: number; kind: string; at: string; lesson_id: string; claim: string }
export interface ActivityFeedPage { events: ActivityEvent[]; cursor: string | null; has_more: boolean }
export function listActivity(options?: { cursor?: string }): Promise<ActivityFeedPage>
```

`ActivityEvent` moves out of `ActivityPage.tsx` to sit with it.

**Named `ActivityFeedPage`, not `ActivityPage`.** The server's type is
`ActivityPage`, but the component already owns that name and both would be
imported into the same file. The server has no such collision, which is why the
names diverge here rather than in `db/lessons.ts`.

**Placed in `lessonsApi.ts`, not a new `activityApi.ts`.** This mirrors the
server, where `listActivityPage` sits beside `listLessonsPage` in
`db/lessons.ts` because, in the prior spec's words, "this is the second read over
the same feed the browse routes already page through." The activity feed *is*
the lesson feed. The cost is a filename that now covers a route which is not
`/api/lessons`; accepted knowingly, because splitting the client while the server
stays joined would make the two harder to read together, and the pairing is the
thing worth preserving.

## Section 2 — Component state *(approved)*

Five pieces, against `LessonsPage`'s eight:

```ts
events: ActivityEvent[] | null   // null until the first page settles
loadError: string | null
cursor: string | null
loadingMore: boolean
moreError: string | null
```

`ActivityPage` stops using `useAuthenticatedFetch` and hand-rolls `load` and
`loadMore` against `listActivity`, matching `LessonsPage` — the established
pattern for a paged screen.

**No `requestSeq`, and the reason belongs in a comment.** `LessonsPage` carries
one (`LessonsPage.tsx:119`) because a filter change mints a new query, and
without a sequence number whichever request *settles* last would win rather than
whichever was *asked* last. `/activity` has no filter. There is no query identity
that can change, so there is nothing to sequence and no stale response that could
outrank a newer one. A reader arriving from `LessonsPage` will look for
`requestSeq` and should learn why it is absent rather than conclude it was
forgotten.

The initial load instead takes the `active`-flag cleanup `useAuthenticatedFetch`
already uses, so an unmount mid-flight does not set state. That is a different
concern from sequencing and it does still apply here.

**`setCursor(page.has_more ? page.cursor : null)` in both paths**, carrying over
the reasoning `LessonsPage` documents at its `load()`: `has_more` and
`cursor !== null` are two facts that happen to agree today, and only one of them
is the question being asked.

`loadMore` guards on `if (!cursor || loadingMore) return` — the whole of the
concurrency control this screen needs.

## Section 3 — Rendering *(approved)*

Appended events concatenate onto `events`. **The existing day grouping then needs
no change**, because it already does not depend on adjacency: `ActivityPage.tsx`
builds a `Map` keyed by day precisely so that same-day events which are not
neighbors in the array still merge. That property was added for a different
reason — concurrent writes can share an `at` while straddling local midnight —
and it happens to be exactly what pagination needs.

The control sits below the panels, not inside the last one: it belongs to the
feed, not to a day.

A failed append keeps the pages already loaded and shows `moreError` beside the
button. A missing tail is not a reason to blank a feed the reader can still use.

The empty state keys off a settled first page with zero events, not on `events`
being absent, so it cannot flash before the first page arrives.

## Section 4 — Testing *(approved)*

**Rewiring.** The five existing tests in `apps/web/src/__tests__/activity-page.test.tsx`
mock `useAuthenticatedFetch` wholesale. They move to mocking `listActivity`, with
their assertions unchanged. This is an improvement rather than a tax: mocking the
hook meant the tests never exercised the component's own data lifecycle, which is
the thing this change adds.

`process.env.TZ = "UTC"` stays pinned at the top of the file, above every import.
The reason is recorded there and is unaffected by this work.

**New cases.** One of these matters more than the others:

1. **Two same-day events split across two pages render one heading, not two.**
   This is the assertion a per-page grouping implementation fails, and it is
   specific to this screen. The fixture must put the day boundary *inside* the
   page boundary or it proves nothing.
2. A second page appends, and the button disappears when `has_more` is false.
3. No button at all when the first page reports `has_more: false`.
4. A failed append preserves the loaded events and surfaces an error.

## What this deliberately does not do *(approved)*

**`mockApi` keeps its empty feed.** `apps/web/src/api/mockApi.ts:707` validates
the activity cursor and then returns permanently empty, and it explains why:
`lesson_feed` rows are written by the machine-authenticated push path, which a
browser cannot reach. Giving the mock invented feed data would create exactly the
mock/API divergence `onlooker-jws` is open about.

The cost is real and worth stating: load-more cannot be exercised in mock mode,
so it can be tested but not eyeballed. If that becomes a problem, the fix is a
seeded feed fixture shared by mock and tests, which is its own bead.

**No shared pagination hook.** `onlooker-bcn` wants `LessonsPage`'s query
lifecycle extracted. Designing that abstraction from `ActivityPage` — the
consumer with no filter, and therefore none of the hard part — would likely get
it wrong. If a shared shape emerges when bcn tackles the harder consumer, it
should absorb `ActivityPage` then.

**No contract change.** The endpoint already returns `cursor` and `has_more`, so
the response shape is untouched and the `api-contract` cases still describe it.

## Rollback

One commit across `lessonsApi.ts`, `ActivityPage.tsx`, and the test file.
`git revert`. No migration, no deploy coupling, no state that outlives the
revert.

## Open questions

None blocking. One deferred: whether a reader wants to reach *old* activity at
all, or only to know it exists. If telemetry ever shows the button pressed once
and never twice, the honest answer may be a count rather than a page.
