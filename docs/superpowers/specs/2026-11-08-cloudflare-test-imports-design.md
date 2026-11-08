# Current cloudflare:workers Imports in the API Tests — Design

Linear: ONL-137.

**The API tests read bindings and call the worker through
`cloudflare:workers`. A lint rule rejects the deprecated `env` and `SELF`
imports from `cloudflare:test`, so the count stops growing.**

## The problem *(measured 2026-11-08)*

* `@cloudflare/vitest-pool-workers` 0.20.3 marks two exports of
  `cloudflare:test` `@deprecated`:
  * `env`: "use `import { env } from "cloudflare:workers"`".
  * `SELF`: "use `import { exports } from "cloudflare:workers"` and
    `exports.default.fetch()`".
* 55 files import them, up from 33 when ONL-137 was filed on 2026-10-04.
  That's 54 under `apps/api/src` and `apps/api/test/apply-migrations.ts`.
  The import lines break down as:
  * 38 files import `{ env }`.
  * 14 import `{ env, SELF }`.
  * 2 import `{ SELF }`.
  * 1 imports `{ applyD1Migrations, env }`.
* There are 141 references to `SELF`, comments included.
* `tsc` and Biome both pass, so nothing stops the next test file from
  copying the old pattern.
* `applyD1Migrations` and the `D1Migration` type are not deprecated.

## The trial *(2026-11-08, reverted)*

* `principal.test.ts`, switched to `cloudflare:workers` `env`, passed 6/6.
* `router.test.ts`, switched to `exports.default`, passed 12/12.
* `tsc --noEmit` passed only with this added to `test/env.d.ts`:
  `interface GlobalProps { mainModule: typeof import("../src/index") }`.
  Without it, `exports.default` fails with "Property 'default' does not
  exist on type 'Exports'". `wrangler types` normally generates that
  declaration. This project doesn't run `wrangler types`.
* The pinned `compatibilityDate: "2024-12-16"` didn't block either import.

## Decisions *(approved)*

* **Migrate**, rather than accept the deprecation.
* `SELF.fetch(…)` becomes `exports.default.fetch(…)`, with no local alias
  named `SELF`. An alias would carry the deprecated name into new files.
* Comments that say "through SELF" say "through the worker's default
  export". The `vitest.config.ts` comment about `main` changes to match.
* `test/env.d.ts` gains the `GlobalProps` declaration, with a comment saying
  why it's there.
* **Biome `noRestrictedImports`** rejects `env` and `SELF` from
  `cloudflare:test` in `apps/api`, with a message that names the
  replacement. `applyD1Migrations` stays allowed. The API's `lint` script
  checks `test` as well as `src`, so `apply-migrations.ts` is covered.

## Tests

* The full API suite, `pnpm --filter @onlooker/api test`, passes after the
  migration, with the same test count as before.
* `tsc --noEmit` passes.
* `pnpm --filter @onlooker/api lint` passes. Restoring one deprecated import
  makes it fail with the rule's message. That's the ablation.

## Out of scope

* Other apps. Only `apps/api` uses the Workers pool.
* Running `wrangler types` to generate the declarations.
