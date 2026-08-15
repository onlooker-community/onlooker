#!/usr/bin/env node
/**
 * Assert that a built bundle calls the API it is supposed to call.
 *
 * VITE_API_BASE_URL is inlined at build time, so which API this app talks to is
 * decided by `vite build` and is unchangeable afterward - a deploy cannot
 * redirect it, and no runtime var can override it. That made a real
 * misconfiguration invisible: one `pnpm build` produced one dist/, both the
 * staging and production deploys shipped it, and app-staging.onlooker.dev spent
 * its life calling the production API against the production database while
 * every config file said otherwise.
 *
 * So the artifact is the only honest source. Read the bundle, not the config.
 *
 * The empty case matters as much as the wrong one. With `--mode staging` and no
 * .env.staging, VITE_API_BASE_URL is unset, and resolveApiConfig() then falls
 * back to the in-memory mock rather than failing - a staging site serving
 * fabricated data and looking perfectly healthy. That build contains no API
 * host at all, which is why a missing URL is an error here and not a pass.
 *
 * Usage: node scripts/verify-api-target.mjs https://api-staging.onlooker.dev
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = "dist/assets";

// Any host that looks like one of ours. Deliberately broad: the failure being
// caught is a bundle aimed at the *wrong* onlooker API, so the check has to
// notice hosts it was not told to expect.
const API_HOST = /https:\/\/api[a-z0-9-]*\.onlooker\.dev/g;

function fail(title, detail) {
	console.error(`error: ${title}\n${detail}`);
	process.exit(1);
}

const expected = process.argv[2];
if (!expected) {
	fail(
		"No expected API URL given",
		"Pass the URL this bundle must call, e.g.\n" +
			"  node scripts/verify-api-target.mjs https://api-staging.onlooker.dev",
	);
}

let bundle;
try {
	bundle = readdirSync(ASSETS_DIR)
		.filter((name) => name.endsWith(".js"))
		.map((name) => readFileSync(join(ASSETS_DIR, name), "utf8"))
		.join("\n");
} catch (cause) {
	fail(
		`Nothing to verify in ${ASSETS_DIR}`,
		`${cause.message}\nRun the build before this check.`,
	);
}

const found = [...new Set(bundle.match(API_HOST) ?? [])];

if (found.length === 0) {
	fail(
		"The bundle calls no API at all",
		`Expected ${expected}, found no onlooker API host in ${ASSETS_DIR}.\n` +
			"VITE_API_BASE_URL was almost certainly unset for this build, which\n" +
			"leaves the app on its in-memory mock. Check that the .env file for\n" +
			"this build mode exists and sets VITE_API_BASE_URL.",
	);
}

const unexpected = found.filter((host) => host !== expected);
if (unexpected.length > 0) {
	fail(
		"The bundle calls the wrong API",
		`Expected only ${expected}, also found: ${unexpected.join(", ")}.\n` +
			"Whichever .env file this build mode resolved to is pointing at the\n" +
			"wrong environment. Shipping this sends real user traffic - signups\n" +
			"included - to that API and its database.",
	);
}

console.log(`bundle calls ${expected}`);
