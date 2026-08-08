# Database Source of Truth — Design

**Status:** Complete — all four sections approved
**Bead:** onlooker-1g9 (packages/db drizzle schema and apps/api raw SQL have drifted apart)
**Date:** 2026-08-08
**Blocks:** subsystem 3 (sync + storage) of the
[shared lesson contract](2026-08-06-shared-lesson-contract-design.md)

---

## Reading this document

The bead describes two schemas that drifted. Investigation found **four**
declarations of the same tables, and the most important one — production —
matches none of the others. This spec picks a single source of truth,
reconciles production to it, and fixes the mechanism that let the divergence go
unreported.

---

## What is actually true today

Verified by direct query against both D1 databases on 2026-08-08.

### Four declarations

| # | Where | State |
|---|---|---|
| 1 | production D1 (`5473b131`) | 4 tables, holds 1 user and 2 sessions, matches nothing else |
| 2 | `apps/api/migrations/0001_init.sql` | 3 tables; staging matches this exactly |
| 3 | `packages/db/src/schema.ts` | 7-table drizzle schema, **zero importers**, never deployed |
| 4 | `apps/api/src/db/queries.ts` | hand-written TypeScript interfaces mirroring the tables |

Declaration 4 is easy to miss and matters: `queries.ts` restates the row shapes
as interfaces, so even "fixing" 2 and 3 would leave a copy free to drift.

### How production differs

| | production | `0001_init.sql` (= staging) | drizzle |
|---|---|---|---|
| `users` name fields | `first_name`, `last_name`, **plus `name` appended by ALTER** | `name` | `name` |
| `users.updated_at` | yes | yes | **missing** |
| `users.deleted_at` | no | no | yes |
| `users.email_verified` | `BOOLEAN` | `BOOLEAN` | ISO text |
| `sessions` token column | `token_hash`, **not UNIQUE** | `token_hash UNIQUE` | **`token`** |
| `sessions` FK | **no `ON DELETE CASCADE`** | `ON DELETE CASCADE` | cascade |
| `audit_logs` | present, column `metadata` | absent | present, column `details` |

Row counts in production: 1 user, 2 sessions, 0 verification tokens, 0 audit
logs.

Indexes diverge too, which is why the verifier in Section 3 compares them
rather than tables alone. Staging has 9, exactly matching `0001_init.sql`.
Production has 14: the same 9, plus 5 on `audit_logs` including a composite
`(user_id, action)`. The drizzle schema declares a third set for that table —
three indexes, no composite, none on `resource_type`. Even the table that
exists in only two of the four declarations manages to differ between them.

Staging was verified table-by-table and index-by-index on 2026-08-08 and is a
byte-for-byte match with `0001_init.sql`; `_cf_KV` and `d1_migrations` are the
only additions, both created by Cloudflare rather than by our source. That
confirms the `_cf_%` exclusion below is necessary rather than defensive.

### The migration ledger is lying

`d1_migrations` on production records `0001_init.sql` as applied at
`2026-08-07 20:19:45` — the run that closed `onlooker-mwb` and `onlooker-bw5`.
Production's tables predate that run and do not match the file.

The cause is `CREATE TABLE IF NOT EXISTS`. Against pre-existing tables every
statement in the migration was a no-op, after which the migration recorded
itself as applied. Staging *looked* fixed because its tables were empty and
were genuinely rebuilt; production silently was not.

This is the same failure shape as the artifact that motivated the lesson
contract: a record that was believed, was wrong, and had nothing structural to
catch it. Any future migration written against the declared state starts from a
false premise.

---

## Section 1 — The reconciled schema *(approved)*

`packages/db` becomes the single source of truth. `apps/api` imports it and
queries through drizzle; `drizzle-kit` generates migrations.

The deciding argument is root cause. The drift happened because **nothing
generates anything** — four hand-maintained declarations with no generator
between them. Choosing the raw SQL preserves that condition and guarantees a
repeat, so the choice is not "which schema is better" but "which option removes
the hand-maintenance." It also lands before subsystem 3 adds lesson tables,
which is exactly when generated migrations and inferred types start paying.

### Corrections before it can be the truth

The drizzle schema has never been checked against a real database. It is wrong
in four places:

| Field | Today | Becomes | Why |
|---|---|---|---|
| `sessions.token` | `token` | `token_hash` | the code stores a hash; both live databases call it `token_hash` |
| `sessions.token_hash` | unconstrained | `UNIQUE` | staging has it, production lost it; a duplicate session token is a real defect |
| `users.updated_at` | absent | added | both live databases have it and `queries.ts` already declares it |
| `users.email_verified` | ISO text | ISO text *(kept)* | records *when*, not just whether |

`users.first_name` / `last_name` are production-only drift and are not adopted;
they collapse into `name` during the rebuild.

### Scope of the schema: three tables, not seven

Ship `users`, `sessions`, and `verification_tokens`. Defer
`email_change_tokens`, `machine_tokens`, and `audit_logs` until the features
that need them exist.

The point of adopting drizzle is that adding a table later is a generated
migration rather than a hand-written one. Pre-building tables for unbuilt
features spends that benefit before earning it. Production's `audit_logs` and
`verification_tokens` are both empty, so deferring costs no data.

`verification_tokens` stays a **single table with a `type` discriminator**,
matching what is deployed, rather than drizzle's split into
`email_verification_tokens` and `password_reset_tokens`. Those two have
identical shapes, so the split buys nothing today. `email_change_tokens`
genuinely differs — it carries `new_email` — which is a reason to add it as its
own table when that feature lands, not now.

`users.deleted_at` is dropped. The WS2 account contract does include
`DELETE /account`, so soft delete is plausibly coming, but no code implements it
and its semantics are undecided. It returns with that feature.

---

## Section 2 — The cutover *(approved)*

### The migration ledger is reset, not built upon

A conventional `0002_rebuild.sql` cannot work here. It would have to transform
two *different* real starting states — production has `first_name` /
`last_name`, staging does not — and a single SQL file cannot select a column
that is absent in one of them. Layering on a ledger already established as false
also inherits the lie.

So both environments are reset to a new baseline:

1. `wrangler d1 export` production to a file. **Verify it contains the user row
   before anything is dropped.** This is the precondition for step 5, not a
   nice-to-have — every other step in this spec is reversible and this one is
   not.
2. Drop all tables in both environments and clear `d1_migrations`.
3. Apply the new drizzle-generated baseline to both.
4. Reimport the user into production, mapping
   `COALESCE(name, first_name || ' ' || last_name)` into `name`, and its boolean
   `email_verified` into a timestamp or null.

Sessions are not carried across. They expire on their own and carry no value, so
the cost is a single re-login.

### Order of work

The first step is what makes the rest safe.

| # | Step | Gate |
|---|---|---|
| 1 | D1 test harness in `apps/api` plus characterization tests for all six query functions, against the **current** schema | tests green before anything changes |
| 2 | Correct the drizzle schema per Section 1; generate the baseline migration | `drizzle-kit` output reviewed |
| 3 | Rewrite `queries.ts` onto drizzle | the same characterization tests stay green |
| 4 | Rebuild staging, verify | `api-staging` healthy, real login round-trip |
| 5 | Rebuild production, reimport the user | only after staging passes |

`apps/api` has **no tests and no test script today**, which is why step 1 exists.
The six functions are `createUser`, `getUserByEmail`, `getUserById`,
`storeRefreshToken`, `getRefreshToken`, `revokeRefreshToken`. `getRefreshToken`
is session validation: a subtle bug there is an auth defect, not a broken
feature.

### What the characterization tests do and do not pin

They pin **function contracts** — create a user then find them by email; store a
refresh token then retrieve it; revoke it and confirm it is gone. Those
contracts do not change across the rewrite.

They do not pin storage representation. `email_verified` deliberately changes
representation, so its test asserts the semantic (verified or not) rather than a
literal value. Where a test must change to accommodate the rewrite, it is not
pinning anything for that path, and that limit is stated rather than implied.

Note that `apps/api/src/types/responses.ts` already declares
`emailVerified?: string | null` while `queries.ts` declares `boolean`. The
timestamp representation does not introduce a change here — it resolves drift
that already exists inside `apps/api`.

---

## Section 3 — The guard *(approved)*

Two mechanisms, because neither alone covers the observed failure.

### Write time: no `IF NOT EXISTS`

That clause is why a migration ran against a schema it did not match, changed
nothing, and reported success. Bare `CREATE TABLE` errors instead, which is the
correct outcome: a migration meeting unexpected state should stop the deploy,
not bless it.

### Deploy time: verify live schema against source

The stronger half. Production's stray `name` column arrived via an out-of-band
`ALTER TABLE` that no migration discipline would have caught. Only comparing
live reality against source catches that class.

```
Apply D1 migrations to <env>        (exists)
  └→ Verify schema matches source   NEW  ← failure stops the deploy here
     └→ Deploy API to <env>         (exists)
```

Verifying *between* migrate and deploy means a worker is never deployed against
a schema it does not expect. That is exactly the failure that let
`api.onlooker.dev` return 200 while being unable to serve a DB-backed route.

The deploy workflow already runs `pnpm migrate:staging` and `pnpm migrate:prod`
as separate gated steps, so both seams already exist.

### Comparison is semantic, not textual

SQLite stores `CREATE TABLE` text verbatim, including comments, whitespace, and
`ALTER`-appended columns, so a string compare would be noisy and fragile.
Compare `PRAGMA table_info` (name, type, notnull, default, pk) plus the index
list, per table. That is order-insensitive where order is irrelevant and still
catches every real difference: the missing `UNIQUE`, the absent `CASCADE`, the
extra column.

Exclude `sqlite_%`, `_cf_%`, and `d1_migrations` — none are declared by our
source.

### The expectation is generated, never hand-written

A hand-maintained snapshot would be a fifth copy of the schema, which is the
disease being cured. It is derived from the drizzle source, committed, and
guarded by a test asserting it matches a fresh generation — the same drift-guard
pattern `packages/lesson-contract` already uses in this repository, so it is
proven here rather than novel.

Failures report a **diff, not a hash**. A fingerprint says *that* something
differs; a diff says *what*. That distinction matters most at the moment it will
be read, which is a failed production deploy.

---

## Section 4 — Failure modes and testing *(approved)*

| Failure | Handling |
|---|---|
| migration hits unexpected state | errors loudly (no `IF NOT EXISTS`); deploy stops before the worker ships |
| schema verification fails post-migrate | deploy stops **before** the worker deploys |
| production reimport fails | the pre-drop export is the recovery path; re-run the import from it |
| staging and production diverge again | verification runs per environment, each checked against source independently |
| miniflare-vs-real-D1 behavior gap | characterization tests cannot catch this; the staging login round-trip in step 4 does |

### The verifier needs a negative test

A guard never observed failing is indistinguishable from a guard that cannot
fail — and the bug this spec exists to fix is a mechanism that reported success
while doing nothing. The schema verifier is therefore fed a deliberately
mismatched schema and must reject it. Without that, we would be trusting a
second unverified mechanism to catch the first.

### Tests

- the six characterization tests, written before the rewrite and green after it
- the generated schema snapshot, guarded by a drift test
- the baseline migration applied to a fresh D1 in tests, so the migration itself
  is exercised rather than assumed
- the verifier's negative case, above
- `queries.ts`'s `User.email_verified` changes `boolean` to `string | null`;
  `responses.ts` already expects that shape, so call sites are checked as part
  of the rewrite

---

## Open questions

**Drift introduced without a deploy is not caught.** The verifier compares live
schema against source at deploy time, so a hand-run `ALTER TABLE` leaves
production diverged until the next deploy notices. Closing that needs scheduled
verification, which is left out under YAGNI and should be revisited if it
happens a second time.

## Not in this spec

Lesson storage tables. Subsystem 3 defines those, and this spec exists so that
it can be built on a schema whose declared state and real state agree.
