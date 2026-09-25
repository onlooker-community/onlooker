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

export interface Rollup {
	sessions: number;
	durationMs: number;
	/** Newest day first, matching the order the page renders panels in. */
	days: DayRollup[];
	/** "Sep 3 – Sep 24", or "" when there are no sessions. */
	range: string;
	longest: SessionSummary | null;
	/** False when the API reported more pages than were loaded. */
	complete: boolean;
}

/** How long a session ran, in ms, or null while it is still running. */
function durationMsOf(session: SessionSummary): number | null {
	if (!session.ended_at) return null;
	const ms =
		new Date(session.ended_at).getTime() -
		new Date(session.started_at).getTime();
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
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

export function rollupSessions(
	sessions: SessionSummary[],
	hasMore: boolean,
): Rollup {
	interface DayRollupInternal extends DayRollup {
		newestStartedAt: string;
	}

	const days = new Map<string, DayRollupInternal>();
	let durationMs = 0;
	let longest: SessionSummary | null = null;
	let longestMs = -1;
	let earliest: string | null = null;
	let latest: string | null = null;

	for (const session of sessions) {
		const day = dayKey(session.started_at);
		const bucket = days.get(day) ?? {
			day,
			sessions: 0,
			durationMs: 0,
			newestStartedAt: session.started_at,
		};
		bucket.sessions += 1;

		// Track the newest timestamp for this day for sorting.
		if (session.started_at > bucket.newestStartedAt) {
			bucket.newestStartedAt = session.started_at;
		}

		const ms = durationMsOf(session);
		if (ms !== null) {
			durationMs += ms;
			bucket.durationMs += ms;
			if (ms > longestMs) {
				longestMs = ms;
				longest = session;
			}
		}
		days.set(day, bucket);

		if (earliest === null || session.started_at < earliest) {
			earliest = session.started_at;
		}
		if (latest === null || session.started_at > latest) {
			latest = session.started_at;
		}
	}

	// Sort days newest first by the newest timestamp seen per day,
	// then strip the internal timestamp field before returning.
	const sortedDays = [...days.values()]
		.sort((a, b) => b.newestStartedAt.localeCompare(a.newestStartedAt))
		.map(({ newestStartedAt, ...rest }) => rest);

	return {
		sessions: sessions.length,
		durationMs,
		days: sortedDays,
		range: earliest && latest ? formatRange(earliest, latest) : "",
		longest,
		complete: !hasMore,
	};
}
