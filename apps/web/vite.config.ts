import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
// vitest/config, not vite: this config carries a `test` block, and only
// vitest's defineConfig types it. Under vite's own the object fell to the last
// overload and reported `test` as an unknown property - invisible to
// `pnpm typecheck`, which includes only src/, but an error in every editor.
import { defineConfig } from "vitest/config";

/**
 * The commit the bundle is being built from, or undefined outside CI.
 *
 * This MUST be the same string src/monitoring.ts reads as
 * VITE_MONITORING_RELEASE, because that is the release the running app stamps
 * its events with. Upload the maps under any other name and Sentry looks for
 * artifacts against a release that has none, which fails the way everything in
 * this area fails: the stack renders, minified, with no error anywhere saying
 * why. Same variable, read once, passed to both.
 */
const release = process.env.VITE_MONITORING_RELEASE;

export default defineConfig({
	plugins: [
		react(),
		// Upload the maps so a production stack names a function and a line
		// instead of index-<hash>.js at column 24518. apps/web is the app that
		// needs this most: a render throw here blanked the dashboard for every
		// logged-in user, the reporting built afterwards caught it, and could
		// not say where it came from.
		//
		// Only the upload is conditional, never the emitting - see build.sourcemap
		// below, which is deliberate and public.
		sentryVitePlugin({
			org: "onlooker-vw",
			project: "onlooker-web",
			// Absent on a local build and on PR builds, which is why this is
			// `disable` rather than a required value: without it the plugin fails
			// the build for want of a credential nobody should need to run
			// `pnpm build`. deploy.yml passes the secret on the two web deploys.
			authToken: process.env.SENTRY_AUTH_TOKEN,
			// Both conditions, and the release is the one that matters.
			//
			// An upload with no release name files the maps under no release,
			// where no event will ever look for them. So refusing is correct on
			// its own terms - but it also happens to separate the only build
			// whose output ships from the one that does not.
			//
			// apps/web is built twice per deploy job: once by the `Build` step
			// (pnpm build, via turbo) and again by `Deploy Web to …`, which
			// rebuilds because VITE_* is inlined and a staging bundle has to be
			// aimed at the staging API. Only the second build is deployed.
			// VITE_MONITORING_RELEASE is set only on those deploy steps, never on
			// `Build`, so this gate tracks that distinction exactly.
			//
			// Without it, the production `Build` step uploaded too - it carries
			// SENTRY_AUTH_TOKEN for the website's astro build in the same step -
			// producing a second artifact bundle per deploy for a bundle that was
			// thrown away. And the staging `Build`, which has no token, emitted
			// four "No auth token provided" warnings that read exactly like the
			// upload failing.
			disable: !process.env.SENTRY_AUTH_TOKEN || !release,
			release: { name: release },
			// filesToDeleteAfterUpload is deliberately NOT set. The maps are
			// emitted on purpose and served (see build.sourcemap), so that a
			// stack is readable in devtools against production and not only
			// inside Sentry. Setting it would quietly reverse that decision.
		}),
	],
	build: {
		// Without this, every client error reported to /api/client-errors
		// arrives as a stack pointing into minified code - index-<hash>.js at
		// column 24518 - which names nothing and locates nothing. The reporting
		// was built after a render throw blanked the dashboard for every
		// logged-in user; it would have caught that error and been unable to
		// say where it came from.
		//
		// Emitted with the reference comment rather than hidden, because this
		// repository is public. Hiding maps protects source that is already on
		// GitHub, and costs the ability to read a stack in devtools against
		// production.
		//
		// Maps make a reported stack readable, not automatically read. Mapping
		// one is still manual today - see onlooker-k34 for what a vendor would
		// add on top of this.
		sourcemap: true,

		// Every icon is a few hundred bytes, so all 80 fall under Vite's default
		// 4096-byte inline limit and land in the JS chunk as base64 - measured
		// at 30,064 bytes, 9.0% of what production shipped on 2026-09-07, and
		// most of it for icons no page renders.
		//
		// Returning false emits them as hashed files instead. The eager glob in
		// Icon.tsx keeps working unchanged; it yields short URLs rather than
		// data URIs, and the unrendered icons then cost disk in dist rather than
		// payload, because nobody fetches a file no page references.
		//
		// A function rather than a smaller number, so this applies to the icons
		// and leaves every other asset on Vite's own size test. `undefined`
		// means "no opinion" - it is not the same as returning false.
		assetsInlineLimit: (filePath: string) =>
			filePath.includes("packages/brand/icons/") ? false : undefined,
	},
	server: {
		port: 5173,
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: ["dist/**/*", "node_modules/**/*"],
	},
});
