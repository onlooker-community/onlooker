import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The brief this harness was built from targets `defineWorkersConfig` /
// `readD1Migrations` from "@cloudflare/vitest-pool-workers/config", which was
// the pre-Vitest-4 config API. The installed range (^0.20.3, the only one
// compatible with this workspace's vitest@4.1.9 - see package's own
// dist/codemods/vitest-v3-to-v4.mjs) replaced that with a Vite plugin,
// `cloudflareTest`, configured the same way `poolOptions.workers` used to be.
//
// Migrations are still read at config time and handed to the test worker as
// a binding, then applied per-suite by test/apply-migrations.ts.
export default defineConfig(async () => {
	const migrations = await readD1Migrations("../../packages/db/migrations");

	return {
		plugins: [
			cloudflareTest({
				// Points the pool at the real worker entry, which is what makes
				// `SELF` from "cloudflare:test" dispatch to our default export.
				// Without it the D1-level tests still run, but nothing can exercise
				// the worker over HTTP - which left routing, status codes and
				// response shapes untested at the only layer apps/web actually sees.
				main: "src/index.ts",
				singleWorker: true,
				miniflare: {
					// Must match wrangler.toml, and must be pinned. Left unset, the
					// test runner asks workerd for *today's* date, so the suite breaks
					// at midnight on any day the installed workerd is older than the
					// calendar - which is every day, since the binary ships behind.
					// It failed in CI and locally on 2026-08-09 for exactly that.
					// Pinning also makes the tests run under the same compatibility
					// date as the deployed worker, rather than a newer one.
					compatibilityDate: "2024-12-16",
					d1Databases: ["DB"],
					// The vars every handler reads. The D1-level tests never needed
					// them because they call queries directly, but anything going
					// through the worker does: without TOKEN_EXPIRY_MINUTES, signup
					// answers 500 "Invalid time period format", because parseInt of
					// undefined is NaN and jose rejects it.
					//
					// Values mirror [env.development] in wrangler.toml. They are
					// repeated here rather than read from it because the pool is
					// configured directly, and a test secret should be obviously a
					// test secret at the point it is declared.
					bindings: {
						TEST_MIGRATIONS: migrations,
						JWT_SECRET: "test-secret-not-used-anywhere-real",
						TOKEN_EXPIRY_MINUTES: "180",
						REFRESH_TOKEN_EXPIRY_DAYS: "30",
						ENVIRONMENT: "test",
						CORS_ORIGIN: "http://localhost:5173",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
