import { createRecordingMonitor } from "@onlooker/monitoring/testing";
import { describe, expect, it } from "vitest";
import { runScheduled } from "./scheduled";
import type { WorkerEnv } from "./types";

// What this file is actually guarding, and why it is worth a file of its own:
// the cron handler does two unrelated jobs, and one of them is this project's
// production health check. The prune runs second, inside its own try/catch,
// and those two facts are the only thing standing between a failing prune and
// a dead heartbeat. Both were verified by hand and by nothing else until now.
//
// See onlooker-kipn.2. The handler body lives in scheduled.ts rather than
// inline in index.ts for the same reason runHeartbeat does: a Worker's
// `scheduled(controller, env, ctx)` signature belongs to the runtime, so
// there is nowhere to pass a fake. Extracting it is what makes the guard
// testable at all.

const env = { ENVIRONMENT: "production" } as unknown as WorkerEnv;

/** Deps that record the order their calls arrive in. */
function recording(
	overrides: {
		heartbeat?: () => Promise<{ label: string; ok: boolean }[]>;
		prune?: () => Promise<number>;
	} = {},
) {
	const calls: string[] = [];
	// createRecordingMonitor returns a RECORDER - the Monitor itself is under
	// `.monitor`, and the arrays beside it are what it wrote down.
	const recorder = createRecordingMonitor();

	return {
		calls,
		recorder,
		deps: {
			runHeartbeat: async () => {
				calls.push("heartbeat");
				return overrides.heartbeat
					? await overrides.heartbeat()
					: [{ label: "api", ok: true }];
			},
			pruneSessionSummaries: async () => {
				calls.push("prune");
				return overrides.prune ? await overrides.prune() : 3;
			},
			monitor: recorder.monitor,
			// Swallowed rather than printed: these tests assert on call order
			// and thrown-ness, and a passing run should not spray JSON through
			// the reporter.
			log: () => {},
		},
	};
}

describe("the cron handler", () => {
	// The ordering half of onlooker-kipn.2. The heartbeat is the production
	// health check; the prune is housekeeping riding the same cron. Running
	// the housekeeping first would put a slow or failing prune in front of the
	// check this project relies on to notice an outage.
	it("runs the heartbeat before the prune", async () => {
		const { calls, deps } = recording();

		await runScheduled(env, deps);

		expect(calls).toEqual(["heartbeat", "prune"]);
	});

	// The containment half, and the one that matters most. An uncaught throw
	// here is recorded by Cloudflare as a failed invocation and tells nobody -
	// the exact failure mode runHeartbeat itself is built to avoid. So a
	// broken prune must not be able to take the handler down with it.
	it("does not let a failing prune throw out of the handler", async () => {
		const { deps } = recording({
			prune: async () => {
				throw new Error("D1 is unavailable");
			},
		});

		await expect(runScheduled(env, deps)).resolves.toBeUndefined();
	});

	// Not throwing is only half of it. Swallowing the failure silently would
	// trade a loud wrong answer for a quiet one, which is what this whole
	// epic exists to stop - so the prune's failure has to surface the same way
	// a failed heartbeat check does.
	it("reports a failing prune through the monitor", async () => {
		const { deps, recorder } = recording({
			prune: async () => {
				throw new Error("D1 is unavailable");
			},
		});

		await runScheduled(env, deps);

		expect(recorder.exceptions).toHaveLength(1);
		const [reported] = recorder.exceptions;
		expect(reported?.error).toBeInstanceOf(Error);
		expect((reported?.error as Error).message).toBe("D1 is unavailable");
	});

	// The heartbeat still has to run to completion when the prune dies, which
	// is the whole point of the ordering above. A regression that moved the
	// prune into the same try as the heartbeat would pass the two tests above
	// and fail this one.
	it("still runs the heartbeat when the prune fails", async () => {
		const { calls, deps } = recording({
			prune: async () => {
				throw new Error("D1 is unavailable");
			},
		});

		await runScheduled(env, deps);

		expect(calls).toContain("heartbeat");
	});
});
