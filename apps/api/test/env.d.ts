// The base "cloudflare:test" module declaration (env, applyD1Migrations, ...)
// lives at @cloudflare/vitest-pool-workers/types. In the installed ^0.20.3
// range it is no longer surfaced through the package's default export - the
// pre-Vitest-4 versions the brief was written against re-exported it there,
// so nothing pulled this reference in implicitly. Without it, tsc cannot see
// `env` or `applyD1Migrations` even though vitest resolves them at runtime.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";

// The installed ^0.20.3 types declare `env` as `Cloudflare.Env`, not the
// `ProvidedEnv` interface a pre-Vitest-4 version of this file targeted.
// `Cloudflare.Env` is the same ambient namespace `wrangler types` normally
// augments (see @cloudflare/workers-types), so bindings are added here the
// same way: by redeclaring `Env` in a project file for TypeScript to merge.
// The `import` above makes this file a module, so the augmentation needs
// `declare global` to reach the ambient namespace rather than staying local.
declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
