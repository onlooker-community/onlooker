# Projects Page and a Project Filter — Design

Linear: ONL-209. Related: ONL-184, ONL-189, ONL-197, ONL-210.

**A `/projects` page lists the viewer's project keys with their names, where they
were seen and their activity. Sessions and Lessons each get a project filter that
the server answers, so it holds up across pages.**

One spec, three PRs, each usable on its own: the data and the page, the Sessions
filter, the Lessons filter.

## Reading this document

Sections marked *(approved)* were settled in conversation on 2026-11-01.
Sections marked *(measured)* were read from this repository on 2026-11-01.

## Where projects live today *(measured)*

* `session_summaries.counts_by_project` is JSON text:
  `{ [12-hex key]: { basis: "remote" | "root", event_count: number } }`. One
  session can touch several keys (17.4% do), and a running session is upserted
  on each sync, so its counts grow.
* `evidence.project_key` is inside a lesson's `body`, with no basis and no
  machine. Evidence never changes after insert: the only writers are
  `createLessonsWithFeed`, and `transitionLesson`, which rewrites only `status`
  and `superseded_by`.
* `project_labels` holds names: `machine_id` is `''` for a remote key and the
  reporting machine for a root key.
* `rollupProjects` and the By repository panel work on loaded sessions only.
* A remote key hashes the repository's origin, so it means the same repository
  for everyone. A root key hashes a local path, so two people, or two machines,
  can hold the same key by coincidence.
* Session summaries are pruned at 180 days. Sessions list on a keyset of
  `(started_at, machine_id, session_id)`, lessons on `(promoted_at, id)`.
* D1 allows 100 bound parameters per query.

## Decisions *(approved)*

**A filter entry is a project name.** Keys that share a name are one entry, and
a key with no name is its own entry. The browser turns an entry into its keys
and the server filters on those, so names never reach a filter query. ONL-197's
CLI labels will only change the grouping.

Rejected: an entry per key, which shows "onlooker" twice and disagrees with the
By repository panel; and a name with expandable keys, which is more UI than
anyone has asked for yet.

**Sessions use a join table,** `session_projects`. Rejected: `json_each` over
`counts_by_project`. It needs no migration and cannot drift, but a filtered page
could scan all of a user's sessions, and `/projects` would too, and D1 bills by
rows read.

**Lessons follow the repo's lifted-column pattern,** as `promoted_at` and
`author_key` did: a `project_key` column, backfilled in the migration.

**On Lessons, a filter matches your own lessons, and other people's only when
your sessions saw that key as remote.** A root key cannot pull in a stranger's
unrelated lesson. Rejected: only your own lessons, which hides teammates' lessons
about the same repository; and anyone with the key, which matches on a
coincidental path hash.

## PR 1: Data and the Projects page

### `session_projects`

| Column | Notes |
|---|---|
| `user_id` | FK to `users`, cascade |
| `machine_id` | part of the key |
| `session_id` | part of the key |
| `project_key` | part of the key |
| `basis` | `remote` or `root` |
| `event_count` | integer |

The primary key is `(machine_id, session_id, project_key)`. A composite foreign
key to `session_summaries (machine_id, session_id)`, `ON DELETE CASCADE`, means
pruning and account deletion need no new code. Index on
`(user_id, project_key)`.

The migration backfills from `json_each(counts_by_project)`.

`putSessionSummaries` rewrites a session's rows in the same D1 batch as the
summary upsert: delete that session's rows, then insert the current ones. A
session's keys and counts can both change between syncs, so an upsert alone
could leave a stale key behind.

### `GET /api/projects`

Session-authenticated. Returns the viewer's projects, one row per key for a
remote key and one per machine and key for a root key:

```ts
{
	project_key: string;
	basis: "remote" | "root" | null;
	machine_id: string | null;
	sessions: number;
	events: number;
	last_seen_at: string | null;
}
```

Rows come from three places, so a project does not disappear when its sessions
pass retention, and its name does not go with it:

1. `session_projects`, which gives the activity.
2. The viewer's own lessons' `project_key`, once PR 3 adds the column. Such a key
   with no session rows has `basis: null`, and the page says "seen on a lesson".
3. The viewer's `project_labels`, with zero activity.

Other accounts' keys are never listed. Names are not in this response: the page
reads `GET /api/project-labels` as Sessions does.

### The page

`/projects` joins `SECTIONS` directly after Sessions, with the Briefcase icon the
By repository panel already uses. It shows each row's name, or its key when there
is none, then the key, where it was seen (remote, or root on a named machine),
sessions, events, last seen, and rename.

`RepositoryName` and `NameEditor` move out of `RepositoriesSummary.tsx` into a
shared component. Sessions keeps its inline control. A root key on a machine
removed from the Machines page still shows that machine's name, because
`GET /api/machines` still returns it.

## PR 2: The Sessions filter

`GET /api/sessions?project=` is repeatable and capped at 50 values. More answers
`400`. Each value is `<key>` for a remote key, or `<machine_id>:<key>` for a root
key, because the same root key on two machines is two projects.

The query narrows `session_summaries` to the pairs found through
`session_projects`, driven by its `(user_id, project_key)` index, so a rarely
used project stays cheap. `user_id` scopes both. The keyset does not change.

`ProjectFilter` is a shared component with one entry per name. Its grouping comes
from one helper, which `reposOf` also moves onto, so the filter and the By
repository panel cannot disagree. Changing the filter clears the cursor and
reloads. It lives in component state, like the status filter.

Sessions keep their project grouping when a project is filtered: a session
touching two projects still shows both.

## PR 3: The Lessons filter

`lessons.project_key` is a nullable text column with an index, backfilled with
`json_extract(body, '$.evidence.project_key')` as the migration's last statement,
and set by `createLessonsWithFeed`. Nullable because SQLite needs a default to
add a NOT NULL column, and an empty default would be a lie.

`GET /api/lessons?project=<key>` is repeatable and capped at 50 values. A lesson
stores no machine, so a root entry sends only its key. The server applies it on
top of `visibilityPredicate`, never instead of it:

```
project_key IN (keys) AND (
	user_id = me
	OR project_key IN (keys the viewer's session_projects holds as remote)
)
```

`GET /api/projects` then includes the viewer's lesson keys (see PR 1). `LessonsPage`
uses `ProjectFilter` beside the status filter. Other accounts' lessons keep
showing their keys, with only remote labels applied: `nameForKey` does not change.

## Tests

Across the PRs:

* A key with no name shows as its key, and filters.
* Two keys sharing a name are one filter entry, and both match.
* The same root key on two machines is two projects.
* A root key on someone else's lesson does not match. A remote key does. An
  entry never reveals another account's project.
* Paging under a filter returns every match once, across pages.
* A second sync replaces a session's rows: a dropped key goes, and counts update.
* Pruning a session and deleting an account clear its `session_projects` rows.
* Both backfills run against seeded rows, as `backfill.test.ts` does.
* A project past retention stays listed if it has a label.
* More than 50 `project` values answers `400`.

`mockApi` gets the same behavior, and the contract tests cover the routes.

## Docs

`apps/api/DEPLOYMENT.md` does not describe these routes. No document changes
beyond this file, and the schema comments on the new table and column.

## Deferred

* Keeping the filter in the URL.
* Picking one key inside a name.
* The stack filter (onlooker-4bw), which can reuse `ProjectFilter`'s shape.
