# Onlooker

Local observability and intelligence for AI-assisted development. Know what
your agents are doing. Learn from every failure.

This repository holds the hosted side of that: the marketing site, the web app,
the API behind it, and the shared packages they are built from. The local-first
tooling lives elsewhere; what is here exists to support the one capability that
cannot be local — sharing lessons between people.

**Status: early.** One deployed user, a working auth and account surface, and no
lesson-sharing yet. The [shared lesson contract](packages/lesson-contract) is
published to npm and is the furthest along.

## Layout

This is a pnpm workspace driven by Turborepo. Everything deploys to Cloudflare.

### Apps

| Path | Deploys to | What it is |
|------|-----------|------------|
| [`apps/website`](apps/website) | `onlooker.dev` | Marketing site. Astro, server-rendered on a Worker. |
| [`apps/web`](apps/web) | `app.onlooker.dev` | The product. React SPA, served as static assets. |
| [`apps/api`](apps/api) | `api.onlooker.dev` | Auth and account API. Worker on D1. |

Each app also has a staging counterpart at `app-staging.` and `api-staging.`.
The website has no staging environment — one worker, one deploy.

### Packages

| Package | What it is |
|---------|-----------|
| [`lesson-contract`](packages/lesson-contract) | The lesson schema, published as `@onlooker-community/lesson-contract`. The only public artifact here. |
| [`api-contract`](packages/api-contract) | The HTTP contract `apps/api` serves, asserted against both the real API and `apps/web`'s mock. See below. |
| [`db`](packages/db) | Drizzle schema and migrations for D1. Owns the schema; the API consumes it. |
| [`auth-core`](packages/auth-core) / [`auth-react`](packages/auth-react) | Framework-agnostic auth primitives, and the React layer over them. |
| [`brand`](packages/brand) | Design tokens, with contrast guarantees enforced by tests. |
| [`cache`](packages/cache) · [`logger`](packages/logger) · [`types`](packages/types) · [`vite-plugins`](packages/vite-plugins) | Shared internals. |
| [`config-biome`](packages/config-biome) · [`config-typescript`](packages/config-typescript) | Shared tool config. |

## Getting started

Node 20.19+, 22.12+ or 24 (see `engines`), and pnpm 11.0.9.

```sh
pnpm install
pnpm dev          # every app in parallel
```

Running the API against a real local database needs its migrations applied once:

```sh
pnpm --filter @onlooker/api exec wrangler d1 migrations apply onlooker-db-local --local --env development
```

Without that, every authenticated route fails with
`Cannot read properties of undefined (reading 'prepare')`.

`apps/web` talks to whatever `VITE_API_BASE_URL` names at build time, and
defaults to an in-memory mock when it is empty. See
[`apps/web/.env.example`](apps/web/.env.example).

### The commands worth knowing

```sh
pnpm test         # every workspace
pnpm lint         # biome
pnpm typecheck
pnpm build

scripts/heartbeat.sh staging      # is the deployed environment alive?
```

## Two things that are easy to get wrong

**The API contract is asserted against both implementations.**
`apps/web` ships a mock so the app is runnable with no backend. That mock and
the real API drifted twice, and both times it cost an outage — a dashboard that
rendered blank for every logged-in user, and a mock that could not stand in for
the real thing at all. [`packages/api-contract`](packages/api-contract) now
holds one table of cases that `apps/api` and the mock each run. A status code or
response shape can only change by changing that file, and changing it fails
whichever side has not caught up.

**Build-time config is per-environment, and cannot be fixed by a deploy.**
`VITE_*` values are inlined into the bundle, so `apps/web` builds separately for
staging and production. `pnpm deploy:web:staging` and `pnpm deploy:web:prod`
each build what they ship, and each fails if the bundle points at the wrong API.
For a while it did: `app-staging.onlooker.dev` served a bundle built against the
production API, and wrote to the production database.

## Deploying

Merging to `main` deploys. Staging goes automatically; production waits on an
approval gate, and only runs if staging succeeded. Both run migrations, verify
the deployed schema matches source, and finish with a smoke test against the
live hostnames.

Deploy scripts always name an environment. There is no environment-less deploy —
it used to exist and would have handed the production hostname to a worker with
no database binding.

See [DEPLOYMENT.md](DEPLOYMENT.md) and
[ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).

## Operations

- [docs/observability-dashboards.md](docs/observability-dashboards.md) — the
  four Cloudflare dashboards, what each answers, and the filters that fail
  silently if you get them wrong. Read the caveats before trusting a chart.
- [docs/runbooks](docs/runbooks) — incident and maintenance procedures.
- A synthetic heartbeat runs on a schedule against both environments. A
  production failure fails the workflow, which is the alerting mechanism.

## Issue tracking

Work is tracked in [beads](https://github.com/gastownhall/beads), not GitHub
Issues. `bd ready` shows what is available; `bd show <id>` explains any
identifier referenced in a commit message or code comment — and many are, since
the reasoning behind a decision usually lives in the bead rather than the diff.

## Contributing

Every change lands through a pull request. Commits follow Conventional Commits.

Comments here tend to explain *why*, often by naming the incident that produced
the rule. That is deliberate: most of the bugs in this repository's history have
been config and code disagreeing with nobody checking, and the comment is
frequently the only thing standing between a reader and undoing the fix.

## License

[MIT](LICENSE).
