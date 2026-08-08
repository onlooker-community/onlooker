// The base "cloudflare:test" module declaration (env, applyD1Migrations, ...)
// lives at @cloudflare/vitest-pool-workers/types. In the installed ^0.20.3
// range it is no longer surfaced through the package's default export - the
// pre-Vitest-4 versions the brief was written against re-exported it there,
// so nothing pulled this reference in implicitly. Without it, tsc cannot see
// `env` or `applyD1Migrations` even though vitest resolves them at runtime.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
		TEST_MIGRATIONS: D1Migration[];
	}
}
