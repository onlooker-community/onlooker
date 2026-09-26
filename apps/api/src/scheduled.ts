import { pruneSessionSummaries } from "./db/session-summaries.js";
import { runHeartbeat } from "./heartbeat";
import { monitor } from "./monitoring";
import type { WorkerEnv } from "./types";

/**
 * The body of the Worker's cron handler, lifted out of index.ts so it can be
 * tested.
 *
 * A Worker's `scheduled(controller, env, ctx)` signature belongs to the
 * runtime, so there is no parameter to pass a fake through - which is why the
 * ordering and the try/catch below went unverified by anything but hand
 * inspection until onlooker-kipn.2. Taking dependencies as an argument is the
 * same shape runHeartbeat already uses one level down, for the same reason.
 *
 * Defaults are the real thing, so index.ts calls this with one argument and
 * nothing about production behavior changes.
 */
export type ScheduledDeps = {
	runHeartbeat: (env: WorkerEnv) => Promise<{ label: string; ok: boolean }[]>;
	pruneSessionSummaries: (db: WorkerEnv["DB"]) => Promise<number>;
	monitor: Pick<typeof monitor, "captureException">;
	log: (line: string) => void;
};

const realDeps: ScheduledDeps = {
	runHeartbeat: (env) =>
		runHeartbeat(env, { fetch: (url) => fetch(String(url)), monitor }),
	pruneSessionSummaries,
	monitor,
	log: (line) => console.log(line),
};

export async function runScheduled(
	env: WorkerEnv,
	deps: ScheduledDeps = realDeps,
): Promise<void> {
	const results = await deps.runHeartbeat(env);

	// One structured line, so the run is visible in Workers Logs even when
	// every check passed - "it ran and found nothing wrong" and "it did not
	// run" are different, and only this distinguishes them there.
	deps.log(
		JSON.stringify({
			event: "heartbeat",
			environment: env.ENVIRONMENT ?? "unknown",
			failed: results.filter((result) => !result.ok).length,
			checks: results.map(({ label, ok }) => ({ label, ok })),
		}),
	);

	// Retention cleanup, riding the same cron for the same reason the
	// heartbeat does: this cron is outside GitHub's throttling (see
	// runHeartbeat's doc comment on GitHub's scheduled workflows drifting
	// to a three-hour cadence). Whether Cloudflare keeps its own schedule
	// has not been measured.
	//
	// Caught rather than let through: this handler's other job is the
	// production health check above, and a failed cleanup is not a reason
	// for that check to stop running. Reported the same way a failed
	// heartbeat check is - monitor.captureException, not a throw - so a
	// broken prune shows up in the same place a broken heartbeat would,
	// instead of failing this invocation silently the way an uncaught
	// throw here would (the exact failure mode runHeartbeat itself is
	// built to avoid).
	//
	// The ordering and this catch are pinned by scheduled.test.ts. Moving the
	// prune above the heartbeat, or into the same try, fails that suite.
	try {
		const pruned = await deps.pruneSessionSummaries(env.DB);
		deps.log(JSON.stringify({ event: "session_summaries_pruned", pruned }));
	} catch (error) {
		deps.monitor.captureException(
			error instanceof Error ? error : new Error(String(error)),
			{ tags: { kind: "session_summaries_prune" } },
		);
	}
}
