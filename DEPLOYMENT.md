# Deployment

Deploys are automatic. Merging to `main` ships staging, then waits for a human
to approve production.

There is nothing to run by hand for a normal deploy, and no database to create —
both D1 databases exist and their IDs are committed in `apps/api/wrangler.toml`.

---

## What happens when you merge

`.github/workflows/deploy.yml` runs on every push to `main`:

```
quality  →  test  →  deploy-staging  →  deploy-production
   lint         vitest      │                   │
   tsc                      │                   └─ waits for a required reviewer
                            │
                            ├─ Build
                            ├─ Apply D1 migrations
                            ├─ Verify schema matches source   ← stops here on drift
                            ├─ Deploy API
                            └─ Deploy Web
```

Both deploy jobs run the same three database-facing steps in the same order.
The order is the point: **the schema is verified before the worker ships**, so a
worker is never deployed against a database it does not expect.

`deploy-production` needs `deploy-staging` to succeed, and its GitHub
environment has a required-reviewer rule, so production never goes out
unattended.

## Environments

| | URL | D1 database |
|---|---|---|
| production | `app.onlooker.dev` / `api.onlooker.dev` | `onlooker-db` |
| staging | `app-staging.onlooker.dev` / `api-staging.onlooker.dev` | `onlooker-db-staging` |

Staging deploys on every merge to `main`. There is no separate staging branch.

## Migrations

Migrations are generated from the drizzle schema and live in
`packages/db/migrations`. `apps/api/wrangler.toml` points `migrations_dir`
there for both environments.

To change the schema, edit `packages/db/src/schema.ts` and generate:

```sh
pnpm --filter @onlooker/db exec drizzle-kit generate
pnpm --filter @onlooker/db generate:expected-schema
pnpm --filter @onlooker/db build
```

Commit both the generated migration and the regenerated
`src/expected-schema.ts`. A test fails if the snapshot drifts from the schema,
and CI fails if a live database drifts from the snapshot.

**Never write `IF NOT EXISTS` in a migration.** A migration that meets
unexpected state must error, not silently do nothing. Production once carried a
migration recorded as applied that had changed nothing at all, because every
statement in it was a no-op — the schema verifier exists because of that.

## Secrets

Two GitHub Actions secrets drive the pipeline:

| Secret | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | applying migrations, running the verifier, deploying |
| `CLOUDFLARE_ACCOUNT_ID` | same |

The token needs **D1 : Edit** covering both databases. Scoping it to one
database causes a `7403` on the other, which reads as an auth failure but is an
authorization one.

One worker secret is set per environment:

```sh
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env production
pnpm --filter @onlooker/api exec wrangler secret put JWT_SECRET --env staging
```

Everything else the API reads (`ENVIRONMENT`, `TOKEN_EXPIRY_MINUTES`,
`REFRESH_TOKEN_EXPIRY_DAYS`) is a plain var in `wrangler.toml`, and `DB` is the
D1 binding. See [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).

## When a deploy fails

**`Apply D1 migrations` fails with `table ... already exists`** — the database
holds tables the migration expects to create. This is the correct, loud
failure. Do not force it through; reconcile the database first. See
[the rebuild runbook](docs/runbooks/2026-08-08-database-rebuild.md) for what a
full reconciliation looks like.

**`Verify ... schema matches source` fails** — the live database does not match
`packages/db/src/schema.ts`. The step prints a per-difference diff, naming each
missing table, missing column, changed nullability, or missing index. Nothing
deployed; the worker still running is the previous one.

Because verification runs *before* the deploy step, a failure here means the
database is wrong, not the code that just failed to ship.

**Checking a database by hand:**

```sh
pnpm --filter @onlooker/api exec wrangler d1 execute onlooker-db --env production --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Add `--local` to inspect the miniflare database instead of the real one.

## Deploying without merging

You generally should not — the pipeline exists so that migrate, verify, and
deploy stay in that order. If you must:

```sh
pnpm --filter @onlooker/api exec wrangler deploy --env staging
```

This skips migration and verification, so only do it when you are certain the
schema has not changed.

## See also

- [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) — every var and secret, per environment
- [apps/api/DEPLOYMENT.md](apps/api/DEPLOYMENT.md) — API worker specifics
- [apps/web/DEPLOYMENT.md](apps/web/DEPLOYMENT.md) — web app specifics
- [docs/runbooks/2026-08-08-database-rebuild.md](docs/runbooks/2026-08-08-database-rebuild.md) — the D1 rebuild, already executed, kept as the shape to copy
