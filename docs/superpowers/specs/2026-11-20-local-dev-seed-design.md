# Local dev seed

ONL-300. Approved 2026-11-20.

## Problem

A fresh local stack has nothing to look at. Sessions only arrive when a machine
syncs to `localhost`, and lessons only when a machine pushes them. The current
`pnpm seed:dev <email>` (`scripts/seed-dev-projects.sh`, #254) fills
`/projects` and `/sessions` for an account you sign up first, and nothing else.
Home, Lessons, lesson detail, Activity, Machines and Orgs stay empty, so their
states can only be seen in tests.

## Decisions

- **Target: the local API and its D1 database** (`pnpm dev`, wrangler's
  local SQLite under `apps/api/.wrangler/`). Not the in-browser mock API,
  which loses its state on reload.
- **The seed creates every account it uses.** Nothing to sign up first, so a
  wiped database is one command away from full.
- **Base rows go in through SQL; everything with ingest logic goes through the
  API.** Accounts, the org, memberships, invites, machine tokens and user
  project labels have no ingest path a script can use without mail or a login,
  so they are written with `wrangler d1 execute --local`. Sessions,
  inventories and lessons are pushed to the running local API with each
  machine's token, so ingest validates them against `lesson-contract` and
  builds `lesson_feed`, `lesson_stacks` and `session_projects` exactly as
  production does. A fixture that drifts from the contract fails loudly
  instead of rendering wrongly.
- **It replaces `scripts/seed-dev-projects.sh` and its test.** Its project
  edge cases move into the new fixtures. One command, `pnpm seed:dev`, with no
  arguments.

## What it creates

### Accounts and the org

- `dev@onlooker.test`, the account you log in as, with a fixed dev password
  printed at the end of every run.
- `ada@onlooker.test`, a member of the org.
- `sam@onlooker.test`, not in the org: the author of public lessons from
  outside it.
- Org "Onlooker Dev", owned by dev, with Ada as a member.
- Two invites to it: one pending, whose `/orgs/invites/<token>` link the seed
  prints, and one expired.

### Machines (Machines, Home)

- **seed desktop** and **seed laptop**: live, both with reported
  inventories. The laptop pushes to the org.
- **seed spare**: never used and never reported.
- **seed old laptop**: revoked.
- **seed old desktop**: removed, as in today's seed.
- Inventories cover every branch of Home's silent line: Onlooker plugins that
  sent events this week, ones that sent none (including `ecosystem`, which is
  never listed), one disabled in every scope, one enabled `null`, and one from
  another marketplace.
- Ada and Sam each get one live machine to push their own lessons from.

### Sessions (Home, Sessions, Projects)

- About 25 sessions over the last 7 days on the desktop and laptop, with one
  quiet day in the middle, and older sessions back to 45 days.
- Plugin activity covering every row kind on Home's Plugins panel and the
  Sessions rows: produced, failed beside output, failed only, found nothing,
  skipped, an event type this build doesn't know (unclassified), and one
  session from a CLI older than 2.12.0 with no `counts_by_type`.
- One archivist session whose output is `onlooker.artifact.ready`, so it is
  heard only through the envelope's `plugins`.
- Today's project edge cases: one repository cloned over https and over ssh
  (two keys, one name), a key with no name, a root key on two machines with
  its own name on each, a removed machine's project, a named project past
  retention, and one session across two repositories.

### Lessons (Lessons, lesson detail, Activity, Home)

- dev's lessons: private, org and public; one in each status: active, refuted,
  superseded (pointing at its replacement), retracted. Varied evidence and
  stacks, and some tied to a project so the project filter narrows.
- Ada's org lessons and Sam's public lessons, so the org and public pools hold
  other authors' work.
- Promotion dates spread over two weeks, so Activity has a history and Home's
  Lessons panel has recent events.
- A lesson in a final status is pushed active first, then moved through
  `POST /lessons/:id/status`, so Activity records the transition as it would
  in use.

Not covered: the signed-out pages (login, reset password, verify email), which
need no data.

## How it runs

### Units

`apps/api/scripts/seed-dev/`, next to what it depends on (`bcryptjs`,
`@onlooker-community/lesson-contract`, the API's vitest). Run with `tsx`.

- `fixtures.ts`: pure data built from a `now` argument: accounts, org,
  invites, machines, inventories, sessions, lessons. Dates are relative to
  `now`.
- `sql.ts`: builds the SQL for the base rows from the fixtures. Pure.
- `push.ts`: sends sessions, inventories and lessons to the local API with
  each machine's token, and lesson transitions after them.
- `main.ts`: checks, resets, writes, pushes, then prints.

Root `pnpm seed:dev` runs it through the API package.

### Local only, by construction

- Every wrangler call passes `--local --env development` against
  `onlooker-db-local`. There is no flag to change either.
- The API base URL is fixed to `http://localhost:8787`.
- Before writing anything, `GET /` must answer from that address. If it
  doesn't, the seed stops and says to start `pnpm dev` first.

### Each run replaces the last

It deletes the three `@onlooker.test` accounts, which cascades to their
machines, sessions, lessons, memberships and labels, and deletes orgs whose
ids start with `seed-` (orgs don't cascade from a user). Then it rebuilds.
Every other local account is left alone. Ids, tokens and the password are
fixed, so two runs produce the same rows, dated from a new `now`.

### Order

1. SQL: accounts (bcrypt hashes at the API's cost), org, memberships,
   invites (token hashes the same SHA-256 `hashToken` uses), machine tokens
   (`seed-token-<machine>`, stored hashed), user project labels.
2. API: sessions, then inventories, then lessons in promotion order, then
   lesson status transitions.
3. SQL: mark the revoked machine revoked and the removed machine removed,
   after their data is in, since a revoked token can no longer push.

### Errors

Any non-2xx response stops the run, naming the endpoint and the response body.
A partial seed costs nothing: the next run starts by deleting it.

### Output

The login, the dev password, the pending invite's link, and the pages to open.

## Tests, written first

- Every fixture lesson parses with `ZLesson`.
- The SQL touches only `@onlooker.test` accounts and `seed-` ids, and every
  wrangler invocation carries `--local`.
- Fixture dates move with `now`.
- Coverage: the fixtures include each lesson status and visibility, each
  plugin row kind, and each machine state listed above, asserted from the
  data so a later edit cannot quietly drop one.

## Docs

`docs/development.md`'s seed paragraph is rewritten for the new command: start
`pnpm dev`, run `pnpm seed:dev`, log in as `dev@onlooker.test`.

## Done when

`pnpm dev` then `pnpm seed:dev` gives a login where Home, Lessons, a lesson's
detail, Activity, Sessions, Projects, Machines and Orgs all show data, and
running the seed again gives the same result.
