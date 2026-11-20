/**
 * A week of plugin activity for the home page's Plugins panel (ONL-298).
 *
 * Summed from each session's per-type counts through pluginTallies, the same
 * classification the Sessions page's rows use, so the two pages agree about
 * what a plugin did. Sessions from a CLI older than 2.12.0 carry no per-type
 * counts and add nothing here.
 */

import type { SessionSummary } from "../api/sessionsApi";
import { type PluginTally, pluginTallies } from "./pluginActivity";
import { plural } from "./sessionRollup";

export interface PluginWeek extends PluginTally {
	plugin: string;
	/** Sessions that carried any non-observed event of this plugin. */
	sessions: number;
}

export interface PluginRollup {
	/** Failures first, most first; then output, largest first; then name. */
	rows: PluginWeek[];
	/**
	 * Plugins whose every type is unknown to the schema this app was built
	 * with - a plugin newer than the web app. Named so it does not vanish.
	 */
	unclassified: string[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

function isUnclassified(week: PluginWeek): boolean {
	return (
		week.unknown > 0 &&
		week.output === 0 &&
		week.skipped === 0 &&
		week.lifecycle === 0 &&
		week.failed === 0
	);
}

export function rollupPlugins(sessions: SessionSummary[]): PluginRollup {
	const weeks = new Map<string, PluginWeek>();
	for (const session of sessions) {
		for (const [plugin, tally] of pluginTallies(session.counts_by_type)) {
			const week = weeks.get(plugin) ?? {
				plugin,
				sessions: 0,
				output: 0,
				skipped: 0,
				failed: 0,
				lifecycle: 0,
				unknown: 0,
			};
			week.sessions += 1;
			week.output += tally.output;
			week.skipped += tally.skipped;
			week.failed += tally.failed;
			week.lifecycle += tally.lifecycle;
			week.unknown += tally.unknown;
			weeks.set(plugin, week);
		}
	}

	const all = [...weeks.values()];
	return {
		rows: all
			.filter((week) => !isUnclassified(week))
			.sort(
				(a, b) =>
					b.failed - a.failed ||
					b.output - a.output ||
					byName(a.plugin, b.plugin),
			),
		unclassified: all
			.filter(isUnclassified)
			.map((week) => week.plugin)
			.sort(byName),
	};
}

/** One row's text after the plugin's name: "3 failed · produced 12 in 4 sessions". */
export function describePluginWeek(week: PluginWeek): string {
	const parts: string[] = [];
	if (week.failed > 0) parts.push(`${week.failed} failed`);
	if (week.output > 0) {
		parts.push(`produced ${week.output}`);
	} else if (week.failed === 0) {
		// Only when there is nothing stronger to say: "produced 0" would read as
		// a fault for a plugin that ran and had nothing to do.
		parts.push(week.skipped > 0 ? "skipped" : "found nothing");
	}
	return `${parts.join(" · ")} in ${plural(week.sessions, "session")}`;
}
