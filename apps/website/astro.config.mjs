// @ts-check

import cloudflare from "@astrojs/cloudflare";
import sentry from "@sentry/astro";
import { defineConfig, envField } from "astro/config";

// https://astro.build/config
export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		sentry({
			org: "onlooker-vw",
			project: "javascript-astro",
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
