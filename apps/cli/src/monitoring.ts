import { homedir } from "node:os";
import type { FetchLike } from "@onlooker/monitoring-sentry/node";
import packageJson from "../package.json" with { type: "json" };
import { crashConsent } from "./consent";

/**
 * The onlooker-cli Sentry project. Committed rather than injected because a
 * DSN can only submit events, which is also why apps/api/wrangler.toml
 * commits its own. Undefined means reporting is off for every build.
 */
export const CRASH_DSN: string | undefined =
	"https://23b44c7cb091c101961e6f665ec55d16@o4512074220371968.ingest.us.sentry.io/4512404620181504";

/** Replaced with "production" by `build:release`; undefined in every other build. */
declare const __ONLOOKER_ENVIRONMENT__: string | undefined;

/**
 * Where this bundle runs, in the shared vocabulary.
 *
 * Only a bundle built by release-cli.yml says production. The typeof guard
 * is what keeps a local build, or a test, from throwing a ReferenceError on
 * a name esbuild was never asked to define.
 */
export function buildEnvironment(): "production" | "development" {
	return typeof __ONLOOKER_ENVIRONMENT__ === "string" &&
		__ONLOOKER_ENVIRONMENT__ === "production"
		? "production"
		: "development";
}

export interface CrashDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	dsn?: string | undefined;
}

/**
 * Send one crash, if and only if this machine agreed to.
 *
 * The consent check comes before the import, so a run that crashed on a
 * machine that never opted in does not load Sentry at all. Resolves true only
 * when Sentry accepted the event with a 2xx inside the flush: a refused
 * connection, an error status, a rate limit or a timeout all resolve false.
 * `run()` prints its one line only on true, so the line never claims a
 * report that was not received. The adapter aborts its send at 2 seconds
 * too, so a stalled server cannot keep the process from exiting.
 *
 * Never rejects. It runs in `run()`'s catch, where a second failure would
 * replace the one the user is being told about.
 */
export async function reportCrash(
	error: unknown,
	{ command }: { command: string },
	{ env = process.env, fetchImpl = fetch, dsn = CRASH_DSN }: CrashDeps = {},
): Promise<boolean> {
	if (!crashConsent(env).on || !dsn) return false;
	try {
		const { createNodeMonitor } = await import(
			"@onlooker/monitoring-sentry/node"
		);
		const monitor = createNodeMonitor(
			{
				dsn,
				environment: buildEnvironment(),
				release: `onlooker-cli@${packageJson.version}`,
			},
			{ fetch: fetchImpl, home: homedir() },
		);
		monitor.captureException(error, {
			tags: {
				command,
				os: process.platform,
				arch: process.arch,
				node: process.versions.node.split(".")[0] ?? "unknown",
			},
		});
		return await monitor.flush(2000);
	} catch {
		return false;
	}
}
