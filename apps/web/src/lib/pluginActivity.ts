/**
 * What each plugin did in one session, from its per-type counts (ONL-190).
 *
 * The row's old evidence line counted events per prefix - "19 memory · 8
 * historian" - which says how often something fired and nothing about whether
 * it did its job. Historian firing eight times could be eight results surfaced
 * or eight empty retrievals. The schema's role map (@onlooker-community/schema
 * 3.3, ONL-191) is what tells those apart from the type alone, which is all a
 * session summary keeps.
 *
 * Imported from the package's `event-roles` subpath, never its root: the root
 * re-exports the validator, which loads node:fs and cannot run in a browser.
 */

import { roleOf } from "@onlooker-community/schema/event-roles";
import { type Shape, topShape } from "./sessionRollup";

export interface PluginActivity {
	/** Output events per plugin - the row's leading line. */
	produced: Shape;
	/** Plugins that only started and completed: they ran and found nothing. */
	idle: string[];
	/** Plugins that skipped and produced nothing. */
	skipped: string[];
	/** Failures per plugin, largest first, whatever else the plugin did. */
	failed: { plugin: string; count: number }[];
	/**
	 * Plugins whose every type is unknown to the schema this app was built
	 * with - a plugin newer than the web app. Named so a session that ran one
	 * does not read as having run nothing.
	 */
	unclassified: string[];
}

interface Tally {
	output: number;
	skipped: number;
	failed: number;
	lifecycle: number;
	unknown: number;
}

/** "curator.scan.complete" -> "curator"; the same split counts_by_prefix uses. */
function pluginOf(type: string): string {
	const dot = type.indexOf(".");
	return dot === -1 ? type : type.slice(0, dot);
}

const byName = (a: string, b: string) => a.localeCompare(b);

/**
 * Null when the session carried no per-type counts - a CLI older than 2.12.0 -
 * so the row can fall back to prefixes instead of claiming nothing ran.
 */
export function pluginActivity(
	countsByType: Record<string, number>,
	limit: number,
): PluginActivity | null {
	const entries = Object.entries(countsByType);
	if (entries.length === 0) return null;

	// A Map rather than an object literal: the plugin segment is whatever the
	// event log carried, and "__proto__" or "constructor" would read through
	// Object.prototype on a plain object.
	const tallies = new Map<string, Tally>();
	for (const [type, count] of entries) {
		const role = roleOf(type);
		// The harness rather than a plugin - see the role's definition in the
		// schema.
		if (role === "observed") continue;

		const plugin = pluginOf(type);
		const tally = tallies.get(plugin) ?? {
			output: 0,
			skipped: 0,
			failed: 0,
			lifecycle: 0,
			unknown: 0,
		};
		tally[role ?? "unknown"] += count;
		tallies.set(plugin, tally);
	}

	const all = [...tallies.entries()];
	// Output is the stronger statement, so a plugin that produced is named
	// there and nowhere else on the line - except for failures, which are
	// worth saying beside output.
	const quiet = all.filter(([, t]) => t.output === 0);

	return {
		produced: topShape(
			Object.fromEntries(
				all.filter(([, t]) => t.output > 0).map(([p, t]) => [p, t.output]),
			),
			limit,
		),
		skipped: quiet
			.filter(([, t]) => t.skipped > 0)
			.map(([p]) => p)
			.sort(byName),
		idle: quiet
			.filter(([, t]) => t.skipped === 0 && t.lifecycle > 0)
			.map(([p]) => p)
			.sort(byName),
		failed: all
			.filter(([, t]) => t.failed > 0)
			.map(([plugin, t]) => ({ plugin, count: t.failed }))
			.sort((a, b) => b.count - a.count || byName(a.plugin, b.plugin)),
		unclassified: quiet
			.filter(
				([, t]) =>
					t.unknown > 0 &&
					t.skipped === 0 &&
					t.lifecycle === 0 &&
					t.failed === 0,
			)
			.map(([p]) => p)
			.sort(byName),
	};
}
