# Web home page

Linear: ONL-298. Approved 2026-11-18.

## Problem

Signing in sends you to `/lessons` (`apps/web/src/App.tsx:136`). Each section
answers one question, and nothing shows what happened across sessions,
plugins and lessons at once. To find out, you open each section in turn.

## Decisions

- **A new `/home` page, three panels.** Recent sessions, Plugins, Lessons, in
  that order. Machine health is out of scope for this version.
- **Web only, on endpoints that already exist.** No API change, so no deploy
  ordering. Every number comes from the same rollup code the Sessions page
  uses (`lib/sessionRollup.ts`, `lib/pluginActivity.ts`), so the two pages
  cannot disagree.
- **An overview, never a copy.** Each panel ends with a link to its full
  section. At the foot rather than in the heading, because `Panel`'s title is
  plain text in an h2, and every other panel's is too.
- **Couldn't load is not nothing here.** Each panel loads and fails on its own,
  and a failure never renders as an empty state.
- **The window is today and the six days before it,** from local midnight in
  the reader's timezone, by `started_at` for sessions and `at` for activity.
  Calendar days rather than 168 hours, so the seven day bars and the headline
  count describe the same rows. When the loaded rows don't reach back to the
  window's start and the API reports more pages, the panel says "most recent
  N" instead, the rule `SessionsSummary` already follows.

## Routing and placement

- `/home`, inside `RequireAuth` like the other sections.
- `RootRedirect` sends a signed-in user to `/home` instead of `/lessons`. Not
  signed in still goes to `/login`.
- `SECTIONS` in `components/sections.ts` gets `{ to: "/home", label: "Home" }`
  first. That puts it under `shell-headings.test.tsx` automatically. Its icon
  must clear the coverage floor in `packages/brand/assets.test.ts`, and must
  not be one another section already uses. `Home` is taken by Orgs, so the
  icon is `Sun`, added to `UNPLATED_ICONS`. Probed 2026-11-18 against the
  floor, with Briefcase as the known failure (5%) to prove the probe measures.

## Loading

On mount, in parallel:

1. `listSessions({ limit: 200 })` feeds Recent sessions and Plugins.
2. `listActivity()`, the first page of the reader's own lesson events, feeds
   Lessons.
3. `listMachines()`, then `getMachineInventory(id)` for each machine with no
   `revoked_at` and no `removed_at`, feeds the silent-plugin line of Plugins.

A failed request gets the same `lib/apiErrors.ts` wording the section pages
use.

## Panels

### Recent sessions

Links to `/sessions`.

- Headline: "23 sessions · 14h 10m in the last 7 days", or "most recent 200
  sessions" when capped.
- A bar per day for 7 days, from `rollupSessions`. Days with no sessions show
  as empty bars, not as missing rows.
- The top 3 repositories by event count, from `rollupProjects`, named through
  `ProjectName`.
- Empty (no sessions in the window): says so, and points at `onlooker sync`.

### Plugins

Links to `/sessions`.

**Activity.** `pluginActivity` per session in the window, summed by
`lib/pluginRollup.ts` into one line per plugin:

- Plugins with failures first, flagged with the count.
- Otherwise by output events, largest first: "historian: produced 41 in 18
  sessions".
- A plugin that only ever came back idle or skipped says that, not "produced
  0".
- Plugins `pluginActivity` reports as unclassified are named under
  "unclassified", so a plugin newer than this build does not disappear.

**Silent.** "Installed, no events in 7 days: counsel, customs."

- Inventory ids are `name@marketplace`; a session's `plugins` are bare event
  names. Only `@onlooker-community` ids count, matched by the part before `@`.
  Plugins from other marketplaces never emit Onlooker events.
- A plugin counts as installed when some active machine has a scope with
  `enabled` true or null. Null means the CLI could not tell, and dropping it
  would hide a plugin that may be on.
- The wording is "no events", not "broken". Some plugins fire rarely, and a
  plugin installed for one project is quiet everywhere else.
- If any inventory request fails, the line says it couldn't check, and lists
  nothing. A partial list would name plugins as silent that a failed machine
  may have run.

### Lessons

Links to `/activity`.

- Headline: "2 published · 1 status change in the last 7 days", counted from
  the first `listActivity` page. When that page doesn't reach back 7 days and
  `has_more` is true: "in your latest N events".
- The latest 3 events: claim, "Published" or "Status changed" (the wording
  `ActivityPage` uses), and when. Each links to `/lessons/:id`.
- Empty: says no lesson activity yet, and points at `onlooker sync`.

## Units

- `lib/homeWindow.ts`: the 7-day cutoff, filtering rows into it, and whether
  the window is complete or capped. Pure.
- `lib/pluginRollup.ts`: summing `pluginActivity` across sessions, and the
  silent list from inventories. Pure.
- `pages/HomePage.tsx`: loading and per-panel state.
- `components/DayBar.tsx`: one day's bar row, pulled out of `SessionsSummary`
  so the home panel and the Sessions page draw days the same way. A day with
  no sessions draws an empty track, where `SessionsSummary`'s 2% minimum
  would draw a sliver.
- `components/HomeSessionsPanel.tsx`, `HomePluginsPanel.tsx`,
  `HomeLessonsPanel.tsx`: presentational, deciding nothing, like
  `SessionsSummary`. Flat in `components/`, as every other component is.

## Tests, written first

- `homeWindow`: rows on each side of the cutoff, capped versus complete, and an
  empty input.
- `pluginRollup`: summing across sessions, failure ordering, idle-only and
  skipped-only plugins, unclassified, the `@onlooker-community` match, other
  marketplaces ignored, `enabled` true, false and null, revoked and removed
  machines ignored.
- Each panel: loaded, empty, request failed (renders an error, never the empty
  state), and capped wording. Plugins also: one inventory request failed.
- Routing: `/` goes to `/home` signed in and to `/login` signed out.
- In the browser, against the mock API: light and dark, and phone width with no
  horizontal scroll. The mock never holds sessions (`mockApi.ts`, GET
  /api/sessions), so locally this shows only the empty states. The loaded
  state is covered by the panel tests and checked in production after deploy.

## Delivery

Three PRs, each web only:

1. Route, nav entry, root redirect, `homeWindow`, Recent sessions panel. This
   one also carries this spec.
2. Plugins panel and `pluginRollup`.
3. Lessons panel.

## Done when

`/` takes a signed-in user to `/home`, all three panels are live in production,
and each panel says it couldn't load, rather than showing an empty state, when
its request fails.
