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
					bindings: { TEST_MIGRATIONS: migrations },
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
