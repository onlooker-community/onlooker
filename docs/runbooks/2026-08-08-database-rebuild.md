# Database Rebuild — Staging and Production

> **HUMAN-EXECUTED RUNBOOK. No agent may run Step 5 (production) or the
> destructive parts of Step 3 (staging).** This procedure drops tables in both
> D1 databases. Do not paste these commands into an agent session and let it
> run them; run them yourself, in order, with the Step 1 export in hand before
> you start Step 3.

## Why this exists

`packages/db` is now the single source of truth for the schema (see the
[design spec](../superpowers/specs/2026-08-08-database-source-of-truth-design.md)
for the full investigation). Both live databases predate that source and
don't match it or each other:

- **Production** (`onlooker-db`, id `5473b131-271e-4ce9-84e5-b48a93269dc8`)
  has `users.first_name` / `users.last_name` *and* a `users.name` column
  appended later by an out-of-band `ALTER TABLE`, plus an `audit_logs` table
  no checked-in schema declares. It holds 1 user, 2 sessions, 0 verification
  tokens, 0 audit log rows.
- **Staging** (`onlooker-db-staging`, id
  `ff3a01c8-aedb-4bc2-8231-b8511b353728`) matches the old
  `apps/api/migrations/0001_init.sql`, which is close to the new schema but
  not identical (`users.name` only, no `first_name`/`last_name`; boolean
  `email_verified`; no `audit_logs`).

Production's `d1_migrations` table currently claims `0001_init.sql` is
applied. That record is false: the old migration used
`CREATE TABLE IF NOT EXISTS` against tables that already existed, so every
statement in it no-opped, and the migration then recorded itself as applied
anyway. Staging *looked* fixed because its tables were genuinely empty and
got genuinely rebuilt; production silently was not. Dropping
`d1_migrations` in Steps 3 and 5 below isn't discarding real history — the
history it holds was never true, so both environments are reset to a new
baseline rather than migrated forward from a ledger that lies.

A conventional forward migration can't fix this either way: production has
`first_name`/`last_name` and staging doesn't, so a single `ALTER TABLE`
script can't target both starting states. That's why this is a rebuild, not
a migration.

## What changes for the one production user

| Old (production) | New | Mapping |
|---|---|---|
| `first_name`, `last_name`, `name` | `name` | `COALESCE(name, first_name \|\| ' ' \|\| last_name)` |
| `email_verified BOOLEAN` | `email_verified` — nullable text, ISO 8601 | `TRUE` → a timestamp; `FALSE`/`0` → `NULL` |
| 2 session rows | *(not carried across)* | user re-logs in once |

Sessions are not reinserted. They expire on their own and carry no value
worth preserving across a schema rebuild, so the cost is a single re-login —
that re-login is Step 7's success check, not a bug.

## Prerequisites

- Run every command from the repository root.
- `wrangler` authenticated with access to both D1 databases (`pnpm
  cloudflare:login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` set
  in the environment).
- `pnpm install` has been run, and the checkout has Tasks 1–4 of the
  [database source of truth plan](../superpowers/plans/2026-08-08-database-source-of-truth.md):
  `packages/db/migrations/0000_kind_starjammers.sql` exists, and
  `apps/api/wrangler.toml` points `migrations_dir` at it for both `staging`
  and `production`.
- A place outside this git repository to store the Step 1 backup — it will
  contain a live email address and password hash.

---

## Step 1 — Export production (the precondition for everything else)

Everything from Step 3 onward is destructive. This export is the only way
back, so do not proceed to Step 3 until it is confirmed to contain the user
row.

```sh
pnpm --filter @onlooker/api exec wrangler d1 export onlooker-db --env production --remote --output prod-backup-2026-08-08.sql
```

This runs with `apps/api` as its working directory, so the file lands at
`apps/api/prod-backup-2026-08-08.sql`. Move it out of the repo immediately —
it must never be committed:

```sh
mv apps/api/prod-backup-2026-08-08.sql ~/secure/onlooker/prod-backup-2026-08-08.sql
```

Confirm it actually contains the user row:

```sh
grep -A 2 "INSERT INTO users" ~/secure/onlooker/prod-backup-2026-08-08.sql
```

> **Stop here if:** the file is missing, is empty, has no `INSERT INTO
> users` line, or the match doesn't look like exactly one row of real user
> data. Do not continue to Step 3 or Step 5 without this file confirmed —
> it's the only recovery path for anything that follows.
>
> **Safe to continue if:** the file exists, contains schema DDL *and* data,
> and the `INSERT INTO users` line has one row with a real `id` and `email`.

---

## Step 2 — Capture the user row in the new column shape

Separately from the raw backup above, pull the row already reshaped for
reinsertion in Step 6:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT id, email, password_hash, COALESCE(name, first_name || ' ' || last_name) AS name, email_verified, created_at, updated_at FROM users;"
```

Record the result here as it is run — fill this in during execution, don't
leave it blank or guess:

| Field | Value |
|---|---|
| `id` | |
| `email` | |
| `password_hash` | |
| `name` | |
| `email_verified` (old boolean, as returned) | |
| `created_at` | |
| `updated_at` | |

`email_verified` above is still the *old* boolean column. Step 6 is what
converts it to the new nullable-timestamp shape — don't convert it here.

> **Stop here if:** the query errors, returns zero rows, or returns more
> than one row. Production is documented as holding exactly one user; a
> different result means row counts have changed since this runbook was
> written and it needs re-verifying against current state before you
> continue.
>
> **Safe to continue if:** exactly one row comes back and every field above
> is filled in.

---

## Step 3 — Rebuild staging

Staging goes first and must fully pass Step 4 before Step 5 touches
production.

**3a. List staging's tables**, to confirm what's actually there before
dropping anything:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db-staging --env staging --remote --json --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expect `users`, `sessions`, `verification_tokens`, `d1_migrations`, and
possibly Cloudflare-managed tables prefixed `_cf_` (e.g. `_cf_KV`) — leave
any `_cf_%` table alone, it isn't ours to drop.

> **Stop here if:** the list contains a table other than the ones named
> above and `_cf_%`. That means staging has drifted further than this
> runbook accounts for, and dropping blind could lose something unrecorded.
> Reconcile it first.
>
> **Safe to continue if:** the table list matches the expected set.

**3b. Drop every staging table, including `d1_migrations`.** Children
before parents, so foreign keys don't block the drop:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db-staging --env staging --remote --command "DROP TABLE IF EXISTS verification_tokens; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS d1_migrations;"
```

**3c. Build the workspace**, so the migration and the verifier below both
run against current source rather than a stale `dist/`:

```sh
pnpm build
```

**3d. Apply the new baseline migration:**

```sh
pnpm migrate:staging
```

> **Stop here if:** this errors. Against an empty database (3b just cleared
> it) `0000_kind_starjammers.sql` should apply cleanly. An error here means
> 3b left something behind — check for leftover tables or indexes before
> retrying.
>
> **Safe to continue if:** wrangler reports the migration applied.

**3e. Verify staging's live schema matches source:**

```sh
pnpm --filter @onlooker/db verify:schema onlooker-db-staging staging
```

> **Stop here if:** this prints a diff and exits non-zero. Do not proceed
> to Step 4 with a failing verification — fix the mismatch (or the schema
> source) and rerun until it's clean.
>
> **Safe to continue if:** it prints
> `onlooker-db-staging (staging) matches packages/db/src/schema.ts`.

---

## Step 4 — Confirm staging with a real signup and login

A 200 from the root path proves nothing — `api.onlooker.dev` has previously
returned 200 while unable to serve any DB-backed route. Prove the database
works end to end instead.

Sign up a throwaway user:

```sh
curl -s -X POST https://api-staging.onlooker.dev/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"runbook-check+2026-08-08@onlooker.dev","password":"RunbookCheck123!","name":"Runbook Check"}'
```

> **Stop here if:** this doesn't return `201` with a body containing
> `token`, `refreshToken`, and `user`. Do not proceed to Step 5 — staging
> isn't actually working yet, regardless of what schema verification said.

Log in as that same user:

```sh
curl -s -X POST https://api-staging.onlooker.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"runbook-check+2026-08-08@onlooker.dev","password":"RunbookCheck123!"}'
```

> **Stop here if:** this doesn't return `200` with a fresh `token` and
> `refreshToken`. That would mean signup wrote data login can't read back —
> exactly the class of bug schema verification can't catch, since it
> compares shape, not read/write behavior.
>
> **Safe to continue if:** both calls succeed. Production is not touched
> until this round trip works.

(Optional cleanup: this leaves a `runbook-check+2026-08-08@onlooker.dev`
user in staging. Staging data has no durability guarantee, so leaving it is
fine; delete it manually if you'd rather not.)

---

## Step 5 — Rebuild production (only after Step 4 passes)

> **No agent runs this section.** This is the irreversible step. Confirm
> the Step 1 export one more time before continuing.

**5a. List production's tables:**

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expect `users`, `sessions`, `verification_tokens`, `audit_logs`,
`d1_migrations`, and possibly `_cf_%` tables — leave `_cf_%` alone.

> **Stop here if:** the list doesn't match. Same reasoning as 3a, but the
> stakes here are the live user's only copy of data — do not drop anything
> until this matches what's described above.
>
> **Safe to continue if:** the table list matches the expected set.

**5b. Drop every production table, including `d1_migrations` and
`audit_logs`.** No checked-in schema declares `audit_logs`; it's dropped
along with everything else — it holds 0 rows, so nothing is lost. Children
before parents:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --command "DROP TABLE IF EXISTS audit_logs; DROP TABLE IF EXISTS verification_tokens; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS d1_migrations;"
```

> **Stop here if:** anything about this feels uncertain. This is the point
> of no return; the Step 1 export is the only way back past it.

**5c. Build the workspace** (skip if unchanged since 3c):

```sh
pnpm build
```

**5d. Apply the new baseline migration:**

```sh
pnpm migrate:prod
```

> **Stop here if:** this errors — same as 3d. Check for leftover tables
> before retrying.
>
> **Safe to continue if:** wrangler reports the migration applied.

**5e. Verify production's live schema matches source:**

```sh
pnpm --filter @onlooker/db verify:schema onlooker-db production
```

> **Stop here if:** this prints a diff and exits non-zero. Do not proceed
> to Step 6 with unverified schema — fix it and rerun until clean.
>
> **Safe to continue if:** it prints
> `onlooker-db (production) matches packages/db/src/schema.ts`.

---

## Step 6 — Reinsert the user

Use the values recorded in Step 2. Map the old boolean `email_verified` to
the new nullable ISO 8601 timestamp: `1`/`true` becomes a timestamp,
`0`/`false` becomes `NULL`. A boolean never recorded *when* verification
happened, so there's no original moment to recover — use the time of this
reinsertion as the verified-at value when the old flag was true, and note
that choice here when you fill in the command.

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --command "INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at) VALUES ('<id from Step 2>', '<email from Step 2>', '<password_hash from Step 2>', '<name from Step 2>', <'<ISO timestamp, e.g. this moment>' if email_verified was true, else NULL>, '<created_at from Step 2>', '<updated_at from Step 2>');"
```

> **Stop here if:** the insert errors. A `NOT NULL` violation means a
> Step 2 field is missing; a `UNIQUE` violation on `email` means production
> wasn't actually empty — go back and recheck 5e.

Confirm the row landed as expected:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT id, email, name, email_verified, created_at, updated_at FROM users;"
```

> **Safe to continue if:** exactly one row comes back, `id` and `email`
> match Step 2, and `email_verified` is now an ISO timestamp or `NULL` —
> never `0` or `1`.

---

## Step 7 — Confirm production

Log in as the reinserted user against `api.onlooker.dev`. Sessions were
dropped in Step 5, so this re-login is expected — it's the check, not a
problem. You'll need the account's real password; it can't be recovered
from `password_hash`, so coordinate with whoever knows it if that isn't
you.

```sh
curl -s -X POST https://api.onlooker.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<email from Step 2>","password":"<the account'"'"'s real password>"}'
```

> **Stop here if:** this doesn't return `200` with a `token` and
> `refreshToken`. The Step 1 export is still available to investigate
> against, or to restore from if needed.
>
> **Done if:** the login succeeds. That's this runbook's completion
> condition.

---

## Rollback

If anything from Step 5b onward needs to be undone, the Step 1 export
(`prod-backup-2026-08-08.sql`, moved to secure storage) is the only
recovery path. Nothing before Step 5b is destructive, and no automated
rollback is provided beyond restoring from that file — treat a restore as
its own incident, not a paste-and-go continuation of this runbook.
