/**
 * Turns the session summaries a page has actually loaded into the totals its
 * header states.
 *
 * Pure and React-free so the arithmetic can be tested directly. Asserting a
 * total through a render means a failure tells you the number on screen is
 * wrong without telling you whether the sum or the markup produced it.
 *
 * Every field here describes THE LOADED ROWS, never the account's whole
 * history. `complete` carries that distinction to the view - see
 * components/SessionsSummary.tsx, which changes its wording rather than its
 * numbers when it is false.
 */

import type { SessionSummary } from "../api/sessionsApi";
import { dayKey } from "./dayKey";

export interface DayRollup {
	day: string;
	sessions: number;
	durationMs: number;
}

export interface DayGroup {
	day: string;
	sessions: SessionSummary[];
}

export interface Rollup {
	sessions: number;
	durationMs: number;
	/**
	 * Newest day first. Sorted here rather than inherited from input order,
	 * so this does not depend on the API's ordering.
	 */
	days: DayRollup[];
	/** "Sep 3 – Sep 24", or "" when there are no sessions. */
	range: string;
	longest: SessionSummary | null;
	/** Duration of the longest ended session, or null if none have ended. */
	longestMs: number | null;
	/** False when the API reported more pages than were loaded. */
	complete: boolean;
}

/** How long a session ran, in ms, or null while it is still running. */
export function durationMsOf(
	session: Pick<SessionSummary, "started_at" | "ended_at">,
): number | null {
	if (!session.ended_at) return null;
	const ms =
		new Date(session.ended_at).getTime() -
		new Date(session.started_at).getTime();
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The count, formatted, with `singular` pluralized by a plain trailing "s" -
 * every word this app counts (session, prompt, compaction, day) pluralizes
 * that way, so one helper covers all of them rather than a ternary at each
 * call site.
 */
export function plural(n: number, singular: string): string {
	return `${n.toLocaleString()} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * "18h 20m". Empty for a negative or non-finite input rather than "-3m":
 * clocks disagree and timestamps arrive malformed, and a confident wrong
 * duration is worse than an absent one.
 */
export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/**
 * "Sep 3 – Sep 24", collapsing to one date when the range is a single
 * day.
 */
export function formatRange(firstIso: string, lastIso: string): string {
	const shape: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
	const first = new Date(firstIso);
	const last = new Date(lastIso);
	if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return "";
	const a = first.toLocaleDateString(undefined, shape);
	const b = last.toLocaleDateString(undefined, shape);
	return a === b ? a : `${a} – ${b}`;
}

/**
 * Groups sessions into one bucket per calendar day, newest day first, with
 * sessions within each day newest first too.
 *
 * A Map keyed by day rather than merging same-day sessions that are merely
 * adjacent in `sessions`, since two sessions from different machines can
 * commit with the same `started_at` second and arrive in either order.
 * Shared by SessionsPage's row grouping and rollupSessions's day totals
 * below, so the two orderings are the same code rather than two copies that
 * can drift the way they once did.
 */
export function groupSessionsByDay(sessions: SessionSummary[]): DayGroup[] {
	const groups = new Map<string, SessionSummary[]>();
	for (const session of sessions) {
		const day = dayKey(session.started_at);
		const existing = groups.get(day);
		if (existing) existing.push(session);
		else groups.set(day, [session]);
	}

	const sorted = [...groups.entries()].map(([day, daySessions]) => ({
		day,
		sessions: [...daySessions].sort((a, b) =>
			b.started_at.localeCompare(a.started_at),
		),
	}));

	return sorted.sort((a, b) =>
		b.sessions[0].started_at.localeCompare(a.sessions[0].started_at),
	);
}

export function rollupSessions(
	sessions: SessionSummary[],
	hasMore: boolean,
): Rollup {
	let durationMs = 0;
	let longest: SessionSummary | null = null;
	let longestMs = -1;
	let earliest: string | null = null;
	let latest: string | null = null;

	for (const session of sessions) {
		const ms = durationMsOf(session);
		if (ms !== null) {
			durationMs += ms;
			if (ms > longestMs) {
				longestMs = ms;
				longest = session;
			}
		}

		if (earliest === null || session.started_at < earliest) {
			earliest = session.started_at;
		}
		if (latest === null || session.started_at > latest) {
			latest = session.started_at;
		}
	}

	const days = groupSessionsByDay(sessions).map((group) => ({
		day: group.day,
		sessions: group.sessions.length,
		durationMs: group.sessions.reduce(
			(sum, s) => sum + (durationMsOf(s) ?? 0),
			0,
		),
	}));

	return {
		sessions: sessions.length,
		durationMs,
		days,
		range: earliest && latest ? formatRange(earliest, latest) : "",
		longest,
		longestMs: longestMs >= 0 ? longestMs : null,
		complete: !hasMore,
	};
}
