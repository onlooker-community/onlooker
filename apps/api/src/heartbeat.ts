/**
 * The shallow half of the heartbeat, run from a Cloudflare cron trigger.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/heartbeat.sh, which already does this and
 * more: that script runs from a GitHub scheduled workflow, and GitHub does not
 * run scheduled workflows when it says it will. Measured 2026-09-13 over the
 * last fifteen runs, heartbeat.yml declares a five-minute cron and actually
 * fires every 102 to 280 minutes, median 186. The project believed it had a
 * five-minute production heartbeat and had a three-hour one; a comment in
 * deploy.yml reasoned, until 2026-09-19, about the alarm ringing "up to 31
 * minutes later on the cron". See onlooker-txcu.5.
 * Remeasured 2026-09-19 over 20 runs: a 203-minute median, 332 at the worst.
 * The throttling tightened rather than eased.
 *
 * Cloudflare cron triggers are not subject to that throttling, so the frequent
 * shallow check moves here and the deep authenticated one stays in the
 * workflow, where a slow cadence costs less. Whether Cloudflare keeps its own
 * schedule has not been measured here; what is measured is that GitHub does
 * not keep its own.
 *
 * WHAT THIS CANNOT DO, stated plainly because the gap is easy to miss: it
 * cannot tell you this Worker is down. If the Worker is not running, the cron
 * does not fire, and nothing here reports anything - the absence IS the
 * signal, and nothing is currently watching for it. That is why the checks
 * below are aimed at things OTHER than this Worker: the web app, which is a
 * different Worker, and D1, which is a binding. Checking api.onlooker.dev from
 * inside api.onlooker.dev would only ever confirm what the cron firing already
 * proved.
 */

import type { Monitor } from "@onlooker/monitoring";
import type { WorkerEnv } from "./types";

export interface HeartbeatTarget {
	label: string;
	url: string;
	/**
	 * The status that means healthy, which is not always 200 - see the note on
	 * heartbeatTargets about /auth/me answering 401.
	 */
	expect: number;
}

export interface HeartbeatResult {
	label: string;
	ok: boolean;
	detail: string;
}

export interface HeartbeatDeps {
	fetch: (input: string | URL) => Promise<Response>;
	monitor: Monitor;
}

/**
 * The URLs to fetch, which are the web app's and only the web app's.
 *
 * The deep link is the one that earns its place. This project once served 404
 * for every route except `/`, through several deploys, and was found by a
 * human clicking a link in an email - because `/` is a file on disk and cannot
 * fail that way, so an apex-only check stayed green throughout.
 *
 * scripts/heartbeat.sh also probes this API over HTTP and asserts 401 from
 * /auth/me, which is a better check than it looks: a 200 there would mean the
 * API had stopped requiring authentication, a worse outage than being down and
 * one no "expect 2xx" check would notice. That check is deliberately NOT
 * duplicated here. It would be this Worker fetching its own hostname, which
 * mostly re-proves what the cron firing already did, and a same-zone
 * subrequest that misbehaves would report a false outage every five minutes.
 * The API's own health is covered instead by probeDatabase below, through the
 * binding. The workflow keeps the HTTP assertion, slowly.
 */
export function heartbeatTargets(env: WorkerEnv): HeartbeatTarget[] {
	// A trailing slash here would produce https://host//login, which the web
	// worker answers with the SPA fallback - a 200 that proves nothing.
	const app = env.APP_BASE_URL.replace(/\/+$/, "");

	return [
		{ label: "web app", url: `${app}/`, expect: 200 },
		{ label: "web app deep link", url: `${app}/login`, expect: 200 },
	];
}

/**
 * Read one row from D1, through the binding.
 *
 * Not a fetch of this Worker's own hostname. That would mostly confirm what
 * the cron firing already proved, and a same-zone subrequest that misbehaves
 * would report a false outage every five minutes - which is precisely how an
 * alert channel gets muted, taking the real signal with it. The binding
 * exercises the dependency the API actually fails on: onlooker-ujy measured
 * the worker waiting 43 ms per D1 call at p50, and every authenticated route
 * reaches for it.
 */
async function probeDatabase(env: WorkerEnv): Promise<HeartbeatResult> {
	const label = "api d1 read";
	try {
		await env.DB.prepare("SELECT 1").first();
		return { label, ok: true, detail: "readable" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { label, ok: false, detail: `D1 could not be read: ${reason}` };
	}
}

/**
 * Run the checks and report the failures as one exception.
 *
 * One exception per run, not one per target: a real outage fails every check
 * at once, and four issues describing a single event is how an alert channel
 * earns itself a filter rule.
 *
 * It reports through `Monitor`, which means a failure becomes an issue in the
 * api project, which is what the "API fault (production)" alert rule already
 * watches. No new Sentry object is needed for this to reach a human, and
 * staging cannot page anyone because that rule is scoped to production.
 */
export async function runHeartbeat(
	env: WorkerEnv,
	{ fetch, monitor }: HeartbeatDeps,
): Promise<HeartbeatResult[]> {
	const targets = heartbeatTargets(env);

	const probes = await Promise.all(
		targets.map(async ({ label, url, expect }): Promise<HeartbeatResult> => {
			try {
				const { status } = await fetch(url);
				return status === expect
					? { label, ok: true, detail: `${status}` }
					: {
							label,
							ok: false,
							detail: `${url} answered ${status}, expected ${expect}`,
						};
			} catch (error) {
				// A network error is an outage, not a reason for the checker to
				// crash. An uncaught throw here kills the scheduled handler and
				// reports nothing at all, which is the silence this exists to end.
				const reason = error instanceof Error ? error.message : String(error);
				return {
					label,
					ok: false,
					detail: `${url} could not be reached: ${reason}`,
				};
			}
		}),
	);

	const results = [...probes, await probeDatabase(env)];

	const failures = results.filter((result) => !result.ok);
	if (failures.length > 0) {
		monitor.captureException(
			new Error(
				`heartbeat: ${failures.length} of ${results.length} checks failed - ${failures
					.map((failure) => failure.detail)
					.join("; ")}`,
			),
			{ tags: { kind: "heartbeat" } },
		);
	}

	return results;
}
