# Local Development Guide

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>=20.19`, `>=22.12`, or `>=24.0` | Use a version manager (nvm, mise, etc.) |
| pnpm | `11.0.9` | Pinned via `packageManager` field |

Install pnpm if you don't have it:

```sh
corepack enable
corepack prepare pnpm@11.0.9 --activate
```

## Getting Started

```sh
# 1. Clone the repo
git clone https://github.com/onlooker-community/onlooker.git
cd onlooker

# 2. Install dependencies
pnpm install

# 3. Run the tests
pnpm test
```

There is no environment setup step. Each app carries its own configuration and a
fresh clone runs without a credential: the API's `wrangler.toml` ships a
throwaway `JWT_SECRET` for development, and `wrangler dev` is local-first, so D1
resolves to a SQLite file under `apps/api/.wrangler/` rather than reaching
Cloudflare.

See [Environment Variables](#environment-variables) below for where each app
reads its configuration from.

## Repository Structure

```
onlooker/
├── apps/
│   └── website/          # Astro + Cloudflare Workers site
├── packages/
│   ├── config-biome/     # Shared Biome configuration presets
│   ├── config-typescript/# Shared TypeScript configuration presets
│   ├── types/            # Shared TypeScript types (@onlooker/types)
│   └── vite-plugins/     # Shared Vite plugins (@onlooker/vite-plugins)
├── docs/                 # Project documentation
├── scripts/              # Dev tooling scripts
├── biome.json            # Root Biome config (source of truth)
├── turbo.json            # Turborepo task pipeline
└── pnpm-workspace.yaml   # pnpm workspace definition
```

## Common Commands

All commands run from the repo root via Turbo unless stated otherwise.

### Development

```sh
pnpm dev          # Start all apps/services in parallel (watches for changes)
pnpm go           # Same as dev but with higher concurrency (--concurrency 20)
```

To start only the website:

```sh
cd apps/website
pnpm dev          # Astro dev server at http://localhost:4321
```

### Building

```sh
pnpm build        # Build all packages and apps in dependency order
pnpm build:dev    # Build in dev mode
```

Packages must be built before apps that depend on them. Turbo handles this automatically; if you're working in a single package directly, build its dependencies first:

```sh
pnpm --filter @onlooker/db build
```

`@onlooker/db` is the one that matters in practice: `apps/api` imports from its
`dist`, and both `generate:expected-schema` and `verify:schema` read `dist` too,
so a stale build there shows up as unrelated-looking test failures.

### Testing

```sh
pnpm test              # Run all test suites
pnpm test:coverage     # Run tests with coverage reports
pnpm test:e2e          # Playwright end-to-end tests
```

Run tests for a single package:

```sh
pnpm --filter @onlooker/api test
pnpm --filter @onlooker/db test
```

### Linting and Formatting

```sh
pnpm lint          # Lint all workspaces (biome check)
pnpm format        # Format all files (biome format --write)
```

Fix all auto-fixable issues across the repo:

```sh
pnpm --filter '*' lint:fix
```

Within a single package:

```sh
pnpm lint          # biome check .
pnpm lint:fix      # biome check --write .
pnpm format        # biome format --write .
```

### Type Checking

```sh
pnpm typecheck     # Run tsc --noEmit across all packages
```

### Cleaning

```sh
pnpm clean         # Remove node_modules, .turbo, and build artifacts
pnpm clean:all     # Also removes pnpm-lock.yaml (full reset)
```

## Working with Packages

### Adding a Dependency

```sh
# Add to a specific package
pnpm --filter @onlooker/api add some-package

# Add a dev dependency
pnpm --filter @onlooker/api add -D vitest

# Add a workspace package as a dependency
pnpm --filter @onlooker/web add @onlooker/brand
# pnpm-workspace.yaml has linkWorkspacePackages: true, so use workspace:*
```

### Creating a New Package

1. Create `packages/<name>/package.json` with `"name": "@onlooker/<name>"`
2. Add `"@onlooker/config-biome": "workspace:*"` and `"@onlooker/config-typescript": "workspace:*"` to `devDependencies`
3. Add a `biome.json` that extends the appropriate preset:
   ```json
   { "root": false, "extends": ["@onlooker/config-biome/library.json"] }
   ```
4. Add a `tsconfig.json` that extends the appropriate preset:
   ```json
   { "extends": "@onlooker/config-typescript/base.json", "include": ["src/**/*"] }
   ```
5. Run `pnpm install` to link the package into the workspace

### Biome Configuration Presets

Shared presets live in `packages/config-biome/`. Each package's `biome.json` extends one:

| Preset | Use for |
|---|---|
| `base.json` | Foundation — formatter, linter, assist settings |
| `library.json` | TypeScript/JavaScript packages |
| `react.json` | React component libraries |
| `nextjs.json` | Next.js applications |
| `astro.json` | Astro sites (includes `.astro` file overrides) |

### TypeScript Configuration Presets

Shared presets live in `packages/config-typescript/`. Each package's `tsconfig.json` extends one:

| Preset | Use for |
|---|---|
| `base.json` | Strict base — all packages start here |
| `js-library.json` | ESM libraries targeting ES2022 |
| `node16.json` | CommonJS Node services |
| `react-library.json` | React component libraries |
| `nextjs.json` | Next.js applications |
| `react-native-library.json` | React Native libraries |

## Environment Variables

**There is no root `.env`, and nothing would read one if there were.** This
repository has no `dotenv` dependency, no vitest env-file loading, and no turbo
`globalDotEnv`. Each app reads its configuration from its own place:

| App | Reads from |
|---|---|
| `apps/api` | `apps/api/wrangler.toml` (`[env.*.vars]`) and `wrangler secret` |
| `apps/web` | `apps/web/.env.<mode>`, at build time, `VITE_`-prefixed |
| `apps/website` | the `env.schema` block in `apps/website/astro.config.mjs` |

For the API's full list — every var and secret, and which are real — see
[ENVIRONMENT_VARIABLES.md](../ENVIRONMENT_VARIABLES.md), which
`scripts/source-guards.test.sh` holds to what `WorkerEnv` declares.

`SITE_LAUNCHED` is in that third row rather than a table of its own: it is an
Astro env field with a `default: false` in `astro.config.mjs`, not a shell
variable.

Nothing else reads the process environment. `LOG_LEVEL` and `REDIS_URL` were
listed here for `packages/logger` and `packages/cache`; both packages have since
been removed, for the reasons in the note below.

### What used to be here

`pnpm dev:setup` ran `scripts/setup-dev-env.sh`, which copied a root
`.env.example` to `.env` and generated `ENCRYPTION_KEY`, `NEXTAUTH_SECRET`,
`CRON_SECRET` and `CUBEJS_API_SECRET` into it. All four are gone, along with the
script and the template, because nothing read any of them — there is no
NextAuth, no Cube.js, and no cron consumer in this repository, and as established
above nothing loads a root `.env` at all. The template itself was a Cal.com
`.env.example` carried in wholesale; it documented Webdis, Prometheus, EE
licenses, and telemetry "sent to Onlooker".

Written down rather than quietly deleted, because the instructions were accurate
about the script and the script was the fiction — anyone who followed them ended
up with four generated credentials and no idea they were inert.

`apps/web/.env.example` is a different file and is real. It is unaffected.

`packages/cache` and `packages/logger` went the same way, and for the same
reason. Neither was imported by any app. `cache` was a node-`redis` client whose
key generator addressed workspaces, organizations, billing and EE licenses -
none of which exist here - and `logger` was pino plus
`pino-opentelemetry-transport`. Every deployable in this repository runs on
Cloudflare: `apps/api` is a Worker, `apps/web` is a browser bundle, and
`apps/website` is Astro on the Cloudflare adapter. None of them can run a Node
logger or open a TCP connection to Redis.

`apps/api` logs with `console.error` and a JSON string deliberately, because
that is the form Workers Logs parses into individually queryable fields - see
`src/db/timing.ts`. Adopting pino would have broken that rather than improved
it, which is also why `packages/api-contract/src/redact.ts` was written where it
is instead of in the logger.

## Website App

The website runs on Astro with Cloudflare Workers as the adapter.

```sh
cd apps/website
pnpm dev        # Dev server at http://localhost:4321
pnpm build      # Build for Cloudflare
pnpm preview    # Preview the built site locally

# From the repository root — the website has one worker and no environments,
# which is why this deploy alone carries no environment name.
pnpm deploy:website
```

To generate Cloudflare bindings types after updating `wrangler.toml`:

```sh
cd apps/website
pnpm generate-types
```

## Turborepo

Turbo caches task outputs locally. To bypass the cache for a single run:

```sh
turbo run test --force
```

The task dependency graph in `turbo.json` means:
- `^build` makes every package build its own dependencies first
- `@onlooker/db#test` waits on `@onlooker/db#build`, because the tests read
  `dist` rather than `src`

If Turbo's cache gets stale, clear it:

```sh
rm -rf .turbo
```
