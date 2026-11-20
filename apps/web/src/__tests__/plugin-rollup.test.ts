import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../api/sessionsApi";
import { describePluginWeek, rollupPlugins } from "../lib/pluginRollup";

function session(counts_by_type: Record<string, number>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type,
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
	};
}

describe("rollupPlugins", () => {
	it("sums each plugin across sessions and counts the sessions it ran in", () => {
		const { rows } = rollupPlugins([
			session({ "historian.retrieval.surfaced": 3 }),
			session({
				"historian.retrieval.surfaced": 2,
				"bursar.session.recorded": 1,
			}),
			session({ "tool.file.read": 9 }),
		]);

		expect(rows.map((r) => [r.plugin, r.output, r.sessions])).toEqual([
			["historian", 5, 2],
			["bursar", 1, 1],
		]);
	});

	// Failures are the thing a week's summary most needs to say, so they lead
	// whatever else the plugin did.
	it("puts plugins with failures first, most failures first", () => {
		const { rows } = rollupPlugins([
			session({
				"historian.retrieval.surfaced": 40,
				"scribe.distill.errored": 1,
				"governor.ledger.write_failed": 3,
			}),
		]);

		expect(rows.map((r) => r.plugin)).toEqual([
			"governor",
			"scribe",
			"historian",
		]);
	});

	it("orders by output, then by name", () => {
		const { rows } = rollupPlugins([
			session({
				"bursar.session.recorded": 2,
				"lineage.change.recorded": 2,
				"historian.retrieval.surfaced": 9,
			}),
		]);

		expect(rows.map((r) => r.plugin)).toEqual([
			"historian",
			"bursar",
			"lineage",
		]);
	});

	// A plugin newer than this build would otherwise vanish from the panel.
	it("names a plugin whose every type is unknown under unclassified", () => {
		const rollup = rollupPlugins([session({ "someplugin.new.thing": 2 })]);

		expect(rollup.rows).toEqual([]);
		expect(rollup.unclassified).toEqual(["someplugin"]);
	});

	it("skips sessions from a CLI that sent no per-type counts", () => {
		expect(rollupPlugins([session({})])).toEqual({
			rows: [],
			unclassified: [],
		});
	});
});

describe("describePluginWeek", () => {
	const week = (over: Partial<Parameters<typeof describePluginWeek>[0]>) =>
		describePluginWeek({
			plugin: "p",
			sessions: 1,
			output: 0,
			skipped: 0,
			failed: 0,
			lifecycle: 0,
			unknown: 0,
			...over,
		});

	it("says what a plugin produced and in how many sessions", () => {
		expect(week({ output: 41, sessions: 18 })).toBe(
			"produced 41 in 18 sessions",
		);
	});

	it("leads with failures, beside output", () => {
		expect(week({ failed: 3, output: 12, sessions: 4 })).toBe(
			"3 failed · produced 12 in 4 sessions",
		);
		expect(week({ failed: 1, lifecycle: 2 })).toBe("1 failed in 1 session");
	});

	// "produced 0" reads as a fault; a plugin that ran and found nothing did
	// its job.
	it("says found nothing or skipped rather than produced 0", () => {
		expect(week({ lifecycle: 4, sessions: 2 })).toBe(
			"found nothing in 2 sessions",
		);
		expect(week({ skipped: 4, sessions: 4 })).toBe("skipped in 4 sessions");
	});
});
