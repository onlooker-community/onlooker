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

/** One repository's share of the loaded sessions. */
export interface ProjectRollup {
	/** The opaque 12-hex project key. */
	key: string;
	basis: "remote" | "root";
	/**
	 * The machine a `root` key belongs to, and null for a `remote` one. A root
	 * key hashes a local path, so it only identifies a repository on the
	 * machine that derived it - see rollupProjects.
	 */
	machineId: string | null;
	/** Sessions that touched this repository at all. */
	sessions: number;
	/** Events attributed to this repository, across those sessions. */
	events: number;
}

export interface ProjectsRollup {
	/** Most events first, then by key, then by machine. */
	projects: ProjectRollup[];
	/** Loaded sessions whose `counts_by_project` was empty. */
	unattributed: number;
}

/**
 * Per-repository totals across the loaded sessions (ONL-184).
 *
 * A session that spans several repositories counts once toward each, so the
 * `sessions` column does not sum to the number of sessions loaded - 17.4% of
 * sessions span more than one, which is why the CLI records a map.
 *
 * The grouping is where `basis` matters. A `remote` key is derived from the
 * origin URL and is the same on every machine, so it merges across machines.
 * A `root` key hashes the repository's local path: one key on two machines
 * says only that two paths hashed alike, not that they are one repository.
 * So root keys are grouped by (machine, key) instead, and a row says which
 * machine it belongs to. Merging them would invent a repository; splitting
 * remote ones by machine would hide that it is one.
 */
export function rollupProjects(sessions: SessionSummary[]): ProjectsRollup {
	const groups = new Map<string, ProjectRollup>();
	let unattributed = 0;

	for (const session of sessions) {
		const entries = Object.entries(session.counts_by_project);
		if (entries.length === 0) {
			unattributed += 1;
			continue;
		}

		for (const [key, { basis, event_count }] of entries) {
			const machineId = basis === "root" ? session.machine_id : null;
			// `\n` cannot appear in a hex key or a machine id, so the joined
			// identity cannot collide - the same delimiter the sessions cursor
			// uses for the same reason.
			const identity = `${basis}\n${machineId ?? ""}\n${key}`;
			const existing = groups.get(identity);
			if (existing) {
				existing.sessions += 1;
				existing.events += event_count;
			} else {
				groups.set(identity, {
					key,
					basis,
					machineId,
					sessions: 1,
					events: event_count,
				});
			}
		}
	}

	const projects = [...groups.values()].sort(
		(a, b) =>
			b.events - a.events ||
			a.key.localeCompare(b.key) ||
			(a.machineId ?? "").localeCompare(b.machineId ?? ""),
	);

	return { projects, unattributed };
}

/** A session's event counts, split into what a row shows and what it does not. */
export interface Shape {
	/** "18 memory · 7 historian · 3 session" - the largest `limit` counts. */
	shown: string;
	/** "2 bursar · 1 scribe" - everything else, for the `+N more` title. */
	hidden: string;
	/** How many prefixes `hidden` names. Zero when everything fit. */
	hiddenCount: number;
}

/**
 * The largest `limit` event-type counts, and the tail they displaced.
 *
 * Replaces an earlier `shapeOf` that joined EVERY prefix into one string. A
 * busy session carries nine of them, which rendered as a run-on line the same
 * weight as the session's own time and duration - the longest thing in the
 * row and the least scannable, so it read as noise. See ONL-173.
 *
 * The tail is returned rather than discarded because these numbers appear
 * nowhere else in the app: before this, the page showed all of them, and a
 * truncation that simply dropped the rest would be the only place they ever
 * existed. components/SessionRow.tsx hangs it off the `+N more` title.
 *
 * Sorted by count descending with the prefix name as a tiebreaker, which is
 * `shapeOf`'s own rule kept intact: object key order is however `JSON.parse`
 * happened to produce it, so without the tiebreaker two sessions with
 * identical counts could render in different orders within one list.
 */
export function topShape(counts: Record<string, number>, limit: number): Shape {
	const ordered = Object.entries(counts).sort(
		([aName, aCount], [bName, bCount]) =>
			bCount !== aCount ? bCount - aCount : aName.localeCompare(bName),
	);

	const say = (entries: [string, number][]) =>
		entries
			.map(([prefix, count]) => `${count.toLocaleString()} ${prefix}`)
			.join(" · ");

	const tail = ordered.slice(limit);

	return {
		shown: say(ordered.slice(0, limit)),
		hidden: say(tail),
		hiddenCount: tail.length,
	};
}
