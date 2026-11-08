# cloudflare:workers Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API tests stop using the deprecated `env` and `SELF` exports
of `cloudflare:test`, and a lint rule keeps it that way.

**Architecture:** This is a mechanical import migration across 55 files,
plus one ambient type declaration that makes `exports.default` typecheck.
Then a Biome `noRestrictedImports` rule in `apps/api/biome.json` rejects
the old imports.

**Tech Stack:** Cloudflare Workers, `@cloudflare/vitest-pool-workers`
0.20.3, Vitest 4, TypeScript, Biome 2.5.

Spec: `docs/superpowers/specs/2026-11-08-cloudflare-test-imports-design.md`.

## Global Constraints

* `env` comes from `import { env } from "cloudflare:workers";`.
* The worker is called through `import { exports } from "cloudflare:workers";`
  as `exports.default.fetch(…)`. Don't add a local alias named `SELF`, or
  any other alias for `exports.default`.
* `applyD1Migrations` and the `D1Migration` type stay imported from
  `cloudflare:test`.
* Prose comments that name `SELF` as the way into the worker now say
  "the worker's default export". Keep each comment's meaning.
* Baseline on 2026-11-08 at `82a78f5`: `pnpm --filter @onlooker/api test`
  gives 65 files and 968 tests, all passing. `lint` shows 3 warnings, which
  already exist and belong to ONL-80. After the change the counts are
  identical, and lint shows the same 3 warnings and no errors.
* Edit tracked files with the Edit/Write tools, never the shell. That
  includes these mechanical edits. No `sed -i`, no codemod scripts that
  write files.
* Run one API test file with its name straight after `test` and no `--`:
  `pnpm --filter @onlooker/api test router`.
* A fresh worktree needs the workspace packages built first:
  `pnpm turbo run build --filter='@onlooker/api^...'`.
* Commits go through `/git-workflow:commit`, in American English, with
  `Refs ONL-137` in the body.

---

### Task 1: Migrate the imports

**Files:**
- Modify: `apps/api/test/env.d.ts`
- Modify: `apps/api/vitest.config.ts`, the comment on `main`
- Modify: `apps/api/test/apply-migrations.ts`
- Modify: every file under `apps/api/src` that imports `env` or `SELF` from
  `cloudflare:test` (54 files). List them with
  `grep -rlE 'import \{[^}]*\b(env|SELF)\b[^}]*\} from "cloudflare:test"' apps/api/src`.

**Interfaces:**
- Produces: `Cloudflare.GlobalProps.mainModule`, typed as the API's
  `src/index`, which makes `exports.default` a typed loopback to the worker.

- [ ] **Step 1: Declare the main module**

In `apps/api/test/env.d.ts`, inside `namespace Cloudflare`, directly after
`interface Env { … }`, add:

```ts
		// Types `exports` from "cloudflare:workers", which is how the tests call
		// the worker. `wrangler types` would normally generate this; the project
		// doesn't run it, so it is declared here. Without it `exports.default`
		// doesn't typecheck, which was measured 2026-11-08.
		interface GlobalProps {
			mainModule: typeof import("../src/index");
		}
```

- [ ] **Step 2: Migrate each file**

Apply these rules to each listed file. They are mechanical:

| Import today | Becomes |
|---|---|
| `import { env } from "cloudflare:test";` | `import { env } from "cloudflare:workers";` |
| `import { SELF } from "cloudflare:test";` | `import { exports } from "cloudflare:workers";` |
| `import { env, SELF } from "cloudflare:test";` | `import { env, exports } from "cloudflare:workers";` |
| `import { applyD1Migrations, env } from "cloudflare:test";` | `import { applyD1Migrations } from "cloudflare:test";` and `import { env } from "cloudflare:workers";` |

Then, in the same file:
* Replace every `SELF.fetch(` with `exports.default.fetch(`.
* Handle any other code use of `SELF` (passed as an argument, `SELF.`
  anything else) the same way, with `exports.default`. List such uses in
  your report.
* Reword comments that name `SELF` as the way into the worker, for example
  "through SELF" becomes "through the worker's default export".

Watch for files that declare their own local `exports` variable, or shadow
it. If one does, list it in your report and stop to ask before renaming
anything.

In `apps/api/vitest.config.ts`, change the comment line
``// `SELF` from "cloudflare:test" dispatch to our default export.`` so that
the sentence reads:
``// Points the pool at the real worker entry, which is what makes``
``// `exports.default` from "cloudflare:workers" dispatch to our default export.``
Keep the rest of that comment.

- [ ] **Step 3: Confirm none remain**

Run:

```bash
grep -rnE 'import \{[^}]*\b(env|SELF)\b[^}]*\} from "cloudflare:test"' apps/api/src apps/api/test
grep -rnw 'SELF' apps/api/src apps/api/test apps/api/vitest.config.ts
```

Expected: both print nothing.

- [ ] **Step 4: Run the suite, typecheck and lint**

Run `pnpm --filter @onlooker/api test`. Expected: 65 files and 968 tests,
all passing, the same as the baseline.

Run `pnpm --filter @onlooker/api typecheck`. Expected: exit 0.

Run `pnpm --filter @onlooker/api lint`. Expected: the 3 existing warnings
and nothing else. If organize-imports wants the new import lines reordered,
run `pnpm --filter @onlooker/api exec biome check --write src test`, then
rerun the suite.

- [ ] **Step 5: Commit**

Commit with `/git-workflow:commit`. Include `apps/api/test/env.d.ts`,
`apps/api/vitest.config.ts`, `apps/api/test/apply-migrations.ts` and the
migrated `src` files. Before committing, check `git status --short` against
the grep list from Step 2, so no file is missed and nothing extra is
staged.

---

### Task 2: Reject the deprecated imports

**Files:**
- Modify: `apps/api/biome.json`
- Modify: `apps/api/package.json`, the `lint` script

**Interfaces:**
- Consumes: nothing from Task 1, except that the code is already clean.

- [ ] **Step 1: Lint test/ too**

In `apps/api/package.json`, change `"lint": "biome check src"` to
`"lint": "biome check src test"`.

- [ ] **Step 2: Add the rule**

Replace `apps/api/biome.json` with:

```json
{
	"root": false,
	"extends": ["@onlooker/config-biome/library.json"],
	"linter": {
		"rules": {
			"style": {
				"noRestrictedImports": {
					"level": "error",
					"options": {
						"paths": {
							"cloudflare:test": {
								"importNames": ["env", "SELF"],
								"message": "Deprecated by @cloudflare/vitest-pool-workers. Use `import { env } from \"cloudflare:workers\"`, and call the worker with `import { exports } from \"cloudflare:workers\"` and `exports.default.fetch()`. See ONL-137."
							}
						}
					}
				}
			}
		}
	}
}
```

If Biome 2.5 rejects this shape, check the rule's options with
`pnpm --filter @onlooker/api exec biome explain noRestrictedImports`, and
adapt the JSON to what it accepts, keeping the same paths, names and
message. Describe the change in your report.

- [ ] **Step 3: Prove the rule by ablation**

Make each change below, confirm the result, then restore the file:
* In `apps/api/src/router.test.ts`, add the line
  `import { SELF } from "cloudflare:test";` and use `SELF` once, for example
  `void SELF;`. Run `pnpm --filter @onlooker/api lint`. Expected: an error
  from `noRestrictedImports` carrying the message above.
* In `apps/api/test/apply-migrations.ts`, change the env import back to
  `import { applyD1Migrations, env } from "cloudflare:test";`. Run
  `pnpm --filter @onlooker/api lint`. Expected: the same error, which
  proves `test/` is now linted.
* Confirm `import { applyD1Migrations } from "cloudflare:test";` on its own
  does not error. That's the restored state.

- [ ] **Step 4: Lint, typecheck, test, commit**

Run `pnpm --filter @onlooker/api lint`. Expected: exit 0 and the 3
existing warnings. Run `typecheck`, then `test` (expect 968). Commit with
`/git-workflow:commit`, including both files.

---

### Task 3: Whole-repo check (controller)

- [ ] Run the full `pnpm test`, `pnpm typecheck` and `pnpm lint` from the
  repo root.
