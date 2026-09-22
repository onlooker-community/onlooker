// @ts-check

import cloudflare from "@astrojs/cloudflare";
import sentry from "@sentry/astro";
import { defineConfig, envField } from "astro/config";

// https://astro.build/config
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	vite: {
		build: {
			// Pinned, and the pin is the fix. @sentry/astro reads this setting to
			// decide two things, and the second is not obvious: left *unset* it
			// both forces maps on and auto-sets
			// `sourcemaps.filesToDeleteAfterUpload` to delete every map after
			// upload (@sentry/astro 10.74.0, the exact version package.json
			// pins: build/esm/integration/index.js:65-67 and :241-246).
			//
			// astro+cloudflare runs vite three times and the plugin uploads once
			// per pass, so on 2026-09-20 the first pass uploaded nine maps and
			// deleted them, and a later pass re-uploaded those same nine debug
			// ids with "no sourcemap found" against each. That is the whole of
			// "Bundled 18 files" followed by "Bundled 15 files" in that run.
			//
			// Deleting them also cost something nobody chose. (Not Cloudflare's
			// copy: wrangler never uploaded the server maps under no_bundle, and
			// wrangler.jsonc now says so - see upload_source_maps there.)
			// apps/web/vite.config.ts:76-79 records why the client maps are
			// emitted rather than hidden: this repository is
			// public, so hiding them protects source that is already on GitHub
			// and costs the ability to read a stack in devtools against
			// production. `true` rather than "hidden" is that same decision.
			sourcemap: true,
		},
	},
	integrations: [
		sentry({
			org: "onlooker-vw",
			project: "onlooker-marketing",
			// Absent on PR builds. The plugin skips the upload when this is
			// unset rather than failing the bundle; production deploy.yml
			// passes the GitHub secret so shipped stacks are readable.
			authToken: process.env.SENTRY_AUTH_TOKEN,
		}),
	],
	env: {
		schema: {
			SITE_LAUNCHED: envField.boolean({
				context: "server",
				access: "public",
				default: false,
			}),
		},
	},
});
