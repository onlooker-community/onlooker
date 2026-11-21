/**
 * Plugin failures across a window's sessions, for the home page's stat band
 * and its "Worth a look" cards.
 *
 * Counted the way the Sessions page counts them: pluginActivity reads each
 * session's per-type counts and the schema's role map says which types are
 * failures. A session from a CLI older than 2.12.0 carries no per-type counts
 * and contributes nothing here, which understates rather than invents.
 */

import type { SessionSummary } from "../api/sessionsApi";
import { pluginActivity } from "./pluginActivity";

export interface FailureNote {
	plugin: string;
	count: number;
	session: SessionSummary;
}

export interface Failures {
	/** Every failure in the sessions given. */
	total: number;
	/** How many of the sessions had at least one. */
	sessions: number;
	/** One entry per plugin per session, worst first, then most recent. */
	notes: FailureNote[];
}

export function failuresIn(sessions: SessionSummary[]): Failures {
	let total = 0;
	const notes: FailureNote[] = [];
	// Keyed by machine as well: a session id is only unique within one.
	const failed = new Set<string>();
	for (const session of sessions) {
		const activity = pluginActivity(session.counts_by_type, 1);
		if (!activity) continue;
		for (const { plugin, count } of activity.failed) {
			total += count;
			failed.add(`${session.machine_id}:${session.session_id}`);
			notes.push({ plugin, count, session });
		}
	}
	notes.sort(
		(a, b) =>
			b.count - a.count ||
			b.session.started_at.localeCompare(a.session.started_at),
	);
	return { total, sessions: failed.size, notes };
}
