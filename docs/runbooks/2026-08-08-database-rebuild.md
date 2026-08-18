# Database Rebuild — Staging and Production

> **EXECUTED 2026-08-09 — do not run again.** Both databases were rebuilt from
> `0000_kind_starjammers.sql` and verified by direct query. Re-running this
> would drop live data. Kept as the record of what was done, and as the shape
> to copy if a future rebuild is ever needed. Two deviations from the text
> below: the merge had already landed, so Step 4 was a re-run of the failed
> staging job rather than a merge; and `test@onlooker.dev` was dropped rather
> than preserved, which made Steps 2 and 8 unnecessary. Tracked by onlooker-f35.
> **HUMAN-EXECUTED RUNBOOK. No agent may run the destructive parts of Step 3
> or Step 6, or Step 7's production deploy.** This procedure drops tables in
> both D1 databases. Do not paste these commands into an agent session and
> let it run them; run them yourself, in order, with the Step 1 export in
> hand before you start Step 3.

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
`d1_migrations` in Steps 3 and 6 below isn't discarding real history — the
history it holds was never true, so both environments are reset to a new
baseline rather than migrated forward from a ledger that lies.

A conventional forward migration can't fix this either way: production has
`first_name`/`last_name` and staging doesn't, so a single `ALTER TABLE`
script can't target both starting states. That's why this is a rebuild, not
a migration.

The new baseline migration uses a bare `CREATE TABLE`, not
`CREATE TABLE IF NOT EXISTS` — deliberately, since the `IF NOT EXISTS` no-op
is the exact defect being fixed. That means it **errors if it hits a
database that still has the old tables**, rather than silently doing
nothing. This runbook relies on that: the drop steps must happen *before*
the merge that triggers the migration, not after, or the migration job will
correctly fail.

## What changes for the one production user

| Old (production) | New | Mapping |
|---|---|---|
| `first_name`, `last_name`, `name` | `name` | `COALESCE(name, first_name \|\| ' ' \|\| last_name)` |
| `email_verified BOOLEAN` | `email_verified` — nullable text, ISO 8601 | `TRUE` → a timestamp; `FALSE`/`0` → `NULL` |
| 2 session rows | *(not carried across)* | user re-logs in once |

Sessions are not reinserted. They expire on their own and carry no value
worth preserving across a schema rebuild, so the cost is a single re-login —
that re-login is Step 9's success check, not a bug.

## Prerequisites

- Run every local command from the repository root, on the branch that
  carries Tasks 1–4 of the
  [database source of truth plan](../superpowers/plans/2026-08-08-database-source-of-truth.md)
  (`packages/db/migrations/0000_kind_starjammers.sql` exists, and
  `apps/api/wrangler.toml` points `migrations_dir` at it for both `staging`
  and `production`). Steps 1–3 run from this checkout before that branch is
  merged. Step 6 also runs from this checkout, but only *after* the Step 4
  merge — see Step 6 for why the order matters.
- `wrangler` authenticated with access to both D1 databases (`pnpm
  cloudflare:login`, or `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` set
  in the environment) — needed for the local `wrangler d1 execute`/`export`
  commands in Steps 1, 2, 3, 6, and 8.
- `pnpm install` has been run.
- A place **outside this git repository** to record the Step 1 export and
  the Step 2 row values, created ahead of time (e.g. `mkdir -p
  ~/secure/onlooker`). Both contain a live email address and password hash
  and must never be committed — see the warnings in those steps.
- **Check now whether the `production` GitHub environment has a required
  reviewer gate**: repo Settings → Environments → `production` → look for
  "Required reviewers." The sequence in Steps 4 and 7 branches on the
  answer, so know it before you start rather than when you get there.

---

## Step 1 — Export production (the precondition for everything else)

Everything from Step 3 onward is destructive. This export is the only way
back, so do not proceed to Step 3 until it is confirmed to contain the user
row.

```sh
pnpm --filter @onlooker/api exec wrangler d1 export onlooker-db --env production --remote --output prod-backup-2026-08-08.sql
```

This runs with `apps/api` as its working directory, so the file lands at
`apps/api/prod-backup-2026-08-08.sql`. That filename is now covered by
`.gitignore` (`*backup*.sql`) so it can't be committed by accident, but
don't rely on that alone — move it out of the repo immediately:

```sh
mv apps/api/prod-backup-2026-08-08.sql ~/secure/onlooker/prod-backup-2026-08-08.sql
```

Confirm it actually contains the user row. The table name may or may not be
quoted in the dump, so match both:

```sh
grep -iE 'insert into "?users"?' -A 2 ~/secure/onlooker/prod-backup-2026-08-08.sql
```

> **Stop here if:** the file is missing, is empty, has no `INSERT INTO
> users` line, or the match doesn't look like exactly one row of real user
> data. Do not continue to Step 3 or Step 6 without this file confirmed —
> it's the only recovery path for anything that follows.
>
> **Safe to continue if:** the file exists, contains schema DDL *and* data,
> and the matched line has one row with a real `id` and `email`.

---

## Step 2 — Capture the user row in the new column shape

Separately from the raw backup above, pull the row already reshaped for
reinsertion in Step 8:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT id, email, password_hash, COALESCE(name, first_name || ' ' || last_name) AS name, email_verified, created_at, updated_at FROM users;"
```

**Do not fill in the values below in this file.** This runbook is checked
into git; writing a live `password_hash` into it, even briefly, risks
committing it. Copy the table below into a scratch file in the same secure,
non-repo location as the Step 1 export (e.g.
`~/secure/onlooker/step2-user-row.txt`) and fill it in *there*:

| Field | Value |
|---|---|
| `id` | |
| `email` | |
| `password_hash` | |
| `name` | |
| `email_verified` (old boolean, as returned) | |
| `created_at` | |
| `updated_at` | |

`email_verified` above is still the *old* boolean column. Step 8 is what
converts it to the new nullable-timestamp shape — don't convert it here.

> **Stop here if:** the query errors, returns zero rows, or returns more
> than one row. Production is documented as holding exactly one user; a
> different result means row counts have changed since this runbook was
> written and it needs re-verifying against current state before you
> continue.
>
> **Safe to continue if:** exactly one row comes back and every field above
> is recorded in your scratch file.

**Production now holds a second row.** A `heartbeat@onlooker.dev` account was
created 2026-08-18 for the synthetic heartbeat's authenticated checks — see
[the heartbeat account runbook](2026-08-17-heartbeat-account.md). A future
rebuild must preserve that row or recreate the account afterward; "exactly one
user" above is no longer accurate as a live gate, only as the shape to copy.

---

## Step 3 — Drop staging's tables

This clears staging so the merge in Step 4 can apply the new baseline
migration cleanly. (The migration itself, its verification, and the API
deploy all happen in CI in Step 4 — not here.)

**3a. List staging's tables**, to confirm what's actually there before
dropping anything:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db-staging --env staging --remote --json --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expect `users`, `sessions`, `verification_tokens`, `d1_migrations`, and
possibly Cloudflare-managed tables prefixed `_cf_` (e.g. `_cf_KV`) or
SQLite-managed tables prefixed `sqlite_` (e.g. `sqlite_sequence`) — leave
any `_cf_%` or `sqlite_%` table alone, neither is ours to drop.

> **Stop here if:** the list contains a table other than the ones named
> above, `_cf_%`, or `sqlite_%`. That means staging has drifted further
> than this runbook accounts for, and dropping blind could lose something
> unrecorded. Reconcile it first.
>
> **Safe to continue if:** the table list matches the expected set.

**3b. Drop every staging table, including `d1_migrations`.** Children
before parents, so foreign keys don't block the drop:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db-staging --env staging --remote --command "DROP TABLE IF EXISTS verification_tokens; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS d1_migrations;"
```

> **Safe to continue if:** the command completes without error. Re-run 3a
> if you want to confirm staging is now empty (aside from `_cf_%` or
> `sqlite_%` tables).

---

## Step 4 — Merge to `main` and let CI rebuild staging

Merge the branch carrying Tasks 1–4 (the one this runbook ships on) into
`main` through the normal PR process. Opening the PR alone isn't enough —
`.github/workflows/deploy.yml`'s deploy jobs only run `on: push` to `main`,
so nothing rebuilds staging until the merge actually lands.

Once it lands, go to the Actions tab and watch the **Deploy to Staging**
job. In order, it runs: *Apply D1 migrations to Staging* → *Verify Staging
schema matches source* → *Deploy API to Staging* → *Deploy Web to Staging*.

> **Stop here if:** *Apply D1 migrations to Staging* fails with something
> like "table users already exists" — that means Step 3 didn't fully clear
> staging. Go back, recheck 3a/3b, then re-run the failed job.
>
> **Stop here if:** *Verify Staging schema matches source* fails. That's a
> real schema mismatch, not a process problem — investigate before
> continuing; don't re-run hoping it passes.
>
> **Safe to continue if:** all four steps in the **Deploy to Staging** job
> go green.

**What happens next depends on the gate you checked in Prerequisites**,
because `deploy-production` has `needs: deploy-staging` and will try to
start as soon as staging's job finishes:

- **If `production` has a required-reviewer gate:** `deploy-production`
  will now be waiting for approval. **Do not approve it yet.** Continue to
  Step 5 and Step 6 first — Step 7 is where you come back and approve it.
- **If `production` has no gate:** `deploy-production` starts
  automatically, immediately, before production's tables have been dropped
  (that's Step 6, still ahead of you). Its *Apply D1 migrations to
  Production* step **will fail** — this is expected and fail-safe, the same
  bare-`CREATE TABLE` behavior called out above, not a problem to fix.
  Don't panic and don't try to force it through. Continue to Step 5 and
  Step 6 as normal; Step 7 covers re-running this failed job afterward.

---

## Step 5 — Confirm staging with a real signup and login

A 200 from the root path proves nothing — `api.onlooker.dev` has previously
returned 200 while unable to serve any DB-backed route. Prove the database
works end to end instead. `-w '\n%{http_code}\n'` prints the response body
followed by the actual status code, so the stop conditions below are
observable rather than assumed.

Sign up a throwaway user:

```sh
curl -s -w '\n%{http_code}\n' -X POST https://api-staging.onlooker.dev/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"runbook-check+2026-08-08@onlooker.dev","password":"RunbookCheck123!","name":"Runbook Check"}'
```

> **Stop here if:** the last line printed isn't `201`, or the body above it
> doesn't contain `token`, `refreshToken`, and `user`. Do not proceed to
> Step 6 — staging isn't actually working yet, regardless of what CI's
> schema verification said.

Log in as that same user:

```sh
curl -s -w '\n%{http_code}\n' -X POST https://api-staging.onlooker.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"runbook-check+2026-08-08@onlooker.dev","password":"RunbookCheck123!"}'
```

> **Stop here if:** the last line printed isn't `200`, or the body above it
> is missing a fresh `token` and `refreshToken`. That would mean signup
> wrote data login can't read back — exactly the class of bug schema
> verification can't catch, since it compares shape, not read/write
> behavior.
>
> **Safe to continue if:** both calls print `201` then `200` with the
> expected bodies. Production is not touched until this round trip works.

(Optional cleanup: this leaves a `runbook-check+2026-08-08@onlooker.dev`
user in staging. Staging data has no durability guarantee, so leaving it is
fine; delete it manually if you'd rather not.)

---

## Step 6 — Drop production's tables

> **No agent runs this section.** This is the irreversible step. Confirm
> the Step 1 export one more time before continuing.

**6a. List production's tables:**

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expect `users`, `sessions`, `verification_tokens`, `audit_logs`,
`d1_migrations`, and possibly `_cf_%` or `sqlite_%` tables (e.g.
`sqlite_sequence`) — leave those alone.

> **Stop here if:** the list doesn't match — that is, it contains a table
> other than the ones named above, `_cf_%`, or `sqlite_%`. Same reasoning
> as 3a, but the stakes here are the live user's only copy of data — do not
> drop anything until this matches what's described above.
>
> **Safe to continue if:** the table list matches the expected set.

**6b. Drop every production table, including `d1_migrations` and
`audit_logs`.** No checked-in schema declares `audit_logs`; it's dropped
along with everything else — it holds 0 rows, so nothing is lost. Children
before parents:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --command "DROP TABLE IF EXISTS audit_logs; DROP TABLE IF EXISTS verification_tokens; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS d1_migrations;"
```

> **Stop here if:** anything about this feels uncertain. This is the point
> of no return; the Step 1 export is the only way back past it.
>
> **Safe to continue if:** the command completes without error.

---

## Step 7 — Let the production deploy run

Which of these you do depends on the gate you checked in Prerequisites and
observed in Step 4:

- **If `production` has a required-reviewer gate:** go to the Actions run
  from Step 4, find the paused `deploy-production` job, and approve it now.
- **If `production` has no gate:** `deploy-production` already ran and
  failed at *Apply D1 migrations to Production*, as expected. Find that run
  in the Actions tab and use "Re-run failed jobs." It will succeed now that
  production's tables are dropped.

Either way, watch the job run: *Apply D1 migrations to Production* → *Verify
Production schema matches source* → *Deploy API to Production* → *Deploy
Web to Production*.

> **Stop here if:** *Apply D1 migrations to Production* fails for any
> reason other than the expected "table already exists" case from Step 4's
> no-gate path (which Step 6 should have already resolved) — investigate
> before retrying.
>
> **Stop here if:** *Verify Production schema matches source* fails. Do not
> proceed to Step 8 with unverified schema.
>
> **Safe to continue if:** all four steps in the **Deploy to Production**
> job go green.

---

## Step 8 — Reinsert the user

Use the values recorded in Step 2's scratch file. Map the old boolean
`email_verified` to the new nullable ISO 8601 timestamp: `1`/`true` becomes
a timestamp, `0`/`false` becomes `NULL`. A boolean never recorded *when*
verification happened, so there's no original moment to recover — use the
time of this reinsertion as the verified-at value when the old flag was
true. Get that timestamp with:

```sh
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

Run **exactly one** of the two commands below — whichever matches Step 2's
`email_verified` value — and delete the other rather than hand-editing a
conditional under pressure.

**If Step 2's `email_verified` was `1`/`true`:**

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --command "INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at) VALUES ('<id from Step 2>', '<email from Step 2>', '<password_hash from Step 2>', '<name from Step 2>', '<ISO 8601 timestamp from date -u above>', '<created_at from Step 2>', '<updated_at from Step 2>');"
```

**If Step 2's `email_verified` was `0`/`false`:**

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --command "INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at) VALUES ('<id from Step 2>', '<email from Step 2>', '<password_hash from Step 2>', '<name from Step 2>', NULL, '<created_at from Step 2>', '<updated_at from Step 2>');"
```

> **Stop here if:** the insert errors. A `NOT NULL` violation means a
> Step 2 field is missing; a `UNIQUE` violation on `email` means production
> wasn't actually empty — go back and recheck Step 7.

Confirm the row landed as expected:

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json --command "SELECT id, email, name, email_verified, created_at, updated_at FROM users;"
```

> **Safe to continue if:** exactly one row comes back, `id` and `email`
> match Step 2, and `email_verified` is now an ISO timestamp or `NULL` —
> never `0` or `1`.

---

## Step 9 — Confirm production

Log in as the reinserted user against `api.onlooker.dev`. Sessions were
dropped in Step 6, so this re-login is expected — it's the check, not a
problem. You'll need the account's real password; it can't be recovered
from `password_hash`, so coordinate with whoever knows it if that isn't
you.

```sh
curl -s -w '\n%{http_code}\n' -X POST https://api.onlooker.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<email from Step 2>","password":"<the account'"'"'s real password>"}'
```

> **Stop here if:** the last line printed isn't `200`, or the body above it
> is missing a `token` and `refreshToken`. The Step 1 export is still
> available to investigate against, or to restore from if needed.
>
> **Done if:** the login succeeds. That's this runbook's completion
> condition.

---

## Rollback

If anything from Step 6 onward needs to be undone, the Step 1 export
(`prod-backup-2026-08-08.sql`, moved to secure storage) is the only
recovery path — but restoring it is not a quick undo. It puts back the
**old** schema (`first_name`/`last_name`/`name`, boolean `email_verified`,
`audit_logs`), and by Step 7 the deployed API expects the **new** one. A
restore therefore also means:

1. Reverting the merge/deploy from Step 4 and Step 7 (or otherwise getting
   the old API build back in front of the databases) — the current API
   code will not run correctly against the restored old schema.
2. Restoring production from the Step 1 export. (Staging was never
   exported and doesn't need to be — nothing in staging is irreplaceable.)
3. Re-running schema verification against the restored state before
   trusting the API again.

Treat a restore as its own incident — revert, restore, reverify — not as a
paste-and-go continuation of this runbook.
