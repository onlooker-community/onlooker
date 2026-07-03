# Local Development Guide

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>=20.19`, `>=22.12`, or `>=24.0` | Use a version manager (nvm, mise, etc.) |
| pnpm | `11.0.9` | Pinned via `packageManager` field |
| Redis | `6+` | Required for `@onlooker/cache` locally |

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

# 3. Set up environment variables
pnpm dev:setup
```

`pnpm dev:setup` copies `.env.example` → `.env` and generates any required secrets (`ENCRYPTION_KEY`, etc.). Run it once after cloning; it's safe to re-run and will not overwrite an existing `.env`.

If you need to customize environment variables, edit `.env` directly. See [Environment Variables](#environment-variables) below.

## Repository Structure

```
onlooker/
├── apps/
│   └── website/          # Astro + Cloudflare Workers site
├── packages/
│   ├── cache/            # Redis cache client (@onlooker/cache)
│   ├── config-biome/     # Shared Biome configuration presets
│   ├── config-typescript/# Shared TypeScript configuration presets
│   ├── logger/           # Pino-based logger (@onlooker/logger)
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
pnpm --filter @onlooker/logger build
pnpm --filter @onlooker/cache build
```

### Testing

```sh
pnpm test              # Run all test suites
pnpm test:coverage     # Run tests with coverage reports
pnpm test:e2e          # Playwright end-to-end tests
```

Run tests for a single package:

```sh
pnpm --filter @onlooker/cache test
pnpm --filter @onlooker/logger test
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
pnpm --filter @onlooker/cache add redis

# Add a dev dependency
pnpm --filter @onlooker/logger add -D vitest

# Add a workspace package as a dependency
pnpm --filter @onlooker/website add @onlooker/cache
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

Copy `.env.example` to `.env` and fill in the required values. The setup script handles this automatically (`pnpm dev:setup`).

Key variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL for caching |
| `LOG_LEVEL` | No | `info` | Log verbosity (`debug`, `info`, `warn`, `error`, `fatal`) |
| `ENCRYPTION_KEY` | Yes | auto-generated | 32-byte hex key for encryption |
| `SITE_LAUNCHED` | No | `false` | Feature flag controlling site launch state |

OpenTelemetry, Sentry, and rate limiting are opt-in — see `.env.example` for full details.

## Website App

The website runs on Astro with Cloudflare Workers as the adapter.

```sh
cd apps/website
pnpm dev        # Dev server at http://localhost:4321
pnpm build      # Build for Cloudflare
pnpm deploy     # Build + wrangler deploy
pnpm preview    # Preview the built site locally
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
- `@onlooker/logger` builds before anything that depends on it
- `@onlooker/cache` builds after `@onlooker/logger`
- The website dev server waits for both `cache` and `logger` to be built

If Turbo's cache gets stale, clear it:

```sh
rm -rf .turbo
```
