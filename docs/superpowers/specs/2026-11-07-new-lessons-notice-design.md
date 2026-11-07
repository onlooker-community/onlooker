# New Lessons Notice — Design

Linear: ONL-262. Related: ONL-75 (`useLessonPool`), ONL-73 (in-flight guards).

**When the Lessons tab regains focus, the page asks for page 1 again. If that
page holds lessons the list does not, a "N new lessons" button appears above
the rows. Clicking it starts the list over.**

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-07.
Sections marked *(measured)* were read from this repository on 2026-11-07.

## The problem *(measured)*

The pool pages newest first by `promoted_at DESC, id DESC`
(`readPool`, `apps/api/src/db/pool.ts`), 50 rows per page
(`BROWSE_DEFAULT_LIMIT`, `apps/api/src/db/pool-page.ts`). Each Load more asks
for rows strictly older than the last row shown. A lesson that reaches the pool
after page 1 has loaded and sorts above the last row shown is never returned by
Load more. It appears on a reload, and until then nothing says it exists.

## Decisions *(approved)*

* **Option 1 from the issue:** re-ask for page 1 and compare. Not copy near
  Load more, and not reordering the pool by arrival.
* **Trigger:** the tab becoming visible again (`visibilitychange` to
  `visible`). No timer.
* **On click:** start the list over, through the same `reload` the error
  state's Retry uses. Pages loaded past page 1 are dropped.
* **Detail pane:** untouched. It already survives the list being replaced.

## Out of scope *(approved)*

A lesson pushed late, carrying a `promoted_at` older than page 1's last row,
sorts past page 1 and is not caught. That case needs the pool ordered by
arrival (option 3) and stays open. Say so on ONL-262 when it closes.

## Hook: `useLessonPool`

All new state lives in this file, beside the sequence guard, as ONL-75
requires.

* New state `fresh: { count: number; more: boolean } | null`. Null means no
  notice.
* A `visibilitychange` listener, removed on unmount. When
  `document.visibilityState` becomes `visible`, it runs a check, but only when
  the current query's page 1 is showing: `lessons !== null`, no `loadError`,
  and no `load()` in flight.
* The check reads `requestSeq.current` (it does not mint a new sequence
  number) and calls `listLessons(query())` with no cursor.
* `count` is the number of ids on that page that are not in `lessons`, which
  holds every loaded page. `more` is true when every row on the page is new
  and `has_more` is true, so the notice reads "50+" rather than claiming
  exactly 50.
* A count of zero leaves `fresh` null.
* A result that lands after `requestSeq` has moved on is discarded. A ref
  allows one check in flight at a time, and a second visibility change during
  one is ignored.
* A failed check sets nothing. It is a background check, and an error banner
  for it would be noise.
* `load()` sets `fresh` to null synchronously, with its other resets. A filter
  change, a project change, Retry and the notice itself all clear it.
* The hook returns `fresh`. The notice's click calls the existing `reload`.

## Page: `LessonsPage`

* When `fresh` is set, a `Button` renders directly below the status region,
  above every branch of the list: "1 new lesson, show it", "N new lessons,
  show them", or "N+ new lessons, show them" when `more` is true. Above
  every branch, not inside the rows' `Panel`, so an empty list shows it too
  (approved 2026-11-07, after the Task 1 review): the likeliest reader of
  "Nothing has synced yet" is waiting for their first machine's first
  lesson. The hook sets `fresh` only once page 1 is showing without an
  error, so it never appears over the loading or error states.
* The persistent `role="status"` region appends " · N new" (or " · N+ new")
  to its count, so a screen reader hears the change without a second live
  region.
* After the click, focus moves to the first row's link once the new page
  lands, so it does not fall to the document body when the button unmounts.
  The list already on screen stays until page 1 arrives.

## Tests

In `apps/web/src/__tests__/lessons-page.test.tsx`, through the real `App`, as
the file already does. Visibility is driven by stubbing
`document.visibilityState` and dispatching `visibilitychange`.

1. Regaining focus with one new lesson on page 1 shows "1 new lesson".
2. Clicking it shows the new row and removes the notice.
3. Regaining focus when page 1 holds nothing new shows no notice.
4. A `visibilitychange` to `hidden` sends no request.
5. A check that lands after a filter change shows nothing.
6. A failed check shows nothing, and the list stays.
7. A page where every row is new, with `has_more`, reads "N+" for its length.
8. The status region carries the new count.
9. An empty list shows the notice when a lesson arrives, and the click
   brings that lesson in.

Each test is checked by ablation: remove the code it covers and watch it fail.
