import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { listMachines } from "../api/machinesApi";
import { listSessions, type SessionSummary } from "../api/sessionsApi";
import { LoadMore } from "../components/LoadMore";
import { PALETTE } from "../components/palette";
import { EmptyState, Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { dayKey, timeOf } from "../lib/dayKey";

// A person's own read of the CLI sessions their machines have reported -
// every row here already cleared apps/cli's reporting threshold, so unlike
// ActivityPage this page never has to filter what it shows. See
// sessionsApi.ts's SessionsPage doc comment.

/** How long a session ran, or that it is still running. */
function durationOf(startedAt: string, endedAt: string | null): string {
	if (!endedAt) return "Still running";
	const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
	if (!Number.isFinite(ms) || ms < 0) return "";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return "<1m";
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/**
 * "6,311 tool · 100 session · 81 skill" - the design's own example. Sorted by
 * count descending, largest first, with the prefix name as a tiebreaker so
 * two sessions with the same counts render identically rather than however
 * `JSON.parse` happened to order the object's keys.
 */
function shapeOf(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort(([aName, aCount], [bName, bCount]) =>
			bCount !== aCount ? bCount - aCount : aName.localeCompare(bName),
		)
		.map(([prefix, count]) => `${count.toLocaleString()} ${prefix}`)
		.join(" · ");
}

export default function SessionsPage() {
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	// Tri-state: null until the machines read settles, then whether the user
	// has ever minted one. Needed only to pick between the two empty states
	// below - a populated page never reads it - so a failure here does not
	// become the page's load error. See the comment on that catch, below.
	const [hasMachines, setHasMachines] = useState<boolean | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);
	const [ended, setEnded] = useState(false);

	useEffect(() => {
		// An `active` flag, not a request sequence number - this screen has no
		// filter to mint a second query, so the only thing to guard against is
		// an unmount mid-flight. Same reasoning as ActivityPage's own effect.
		let active = true;
		listSessions()
			.then((page) => {
				if (!active) return;
				setSessions(page.sessions);
				setCursor(page.has_more ? page.cursor : null);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(describeError(error, "Could not load your sessions."));
			});
		// A second, independent read. Kept apart from the sessions fetch rather
		// than folded into one Promise.all: a failure here says nothing about
		// whether the session history loaded, and coupling the two would turn
		// an unrelated machines-list error into a full page failure for a
		// person whose sessions came back fine. Left `null` (unknown) on
		// failure, which the empty-state branch below treats as its own case
		// rather than guessing at either fact.
		listMachines()
			.then(({ machines }) => {
				if (!active) return;
				setHasMachines(machines.length > 0);
			})
			.catch(() => {
				if (!active) return;
				setHasMachines(null);
			});
		return () => {
			active = false;
		};
	}, []);

	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const page = await listSessions({ cursor });
			setSessions((current) => [...(current ?? []), ...page.sessions]);
			setCursor(page.has_more ? page.cursor : null);
			setEnded(!page.has_more);
		} catch (error) {
			// The pages already loaded stay. A failed append is a missing tail.
			setMoreError(describeError(error, "Could not load more sessions."));
		} finally {
			setLoadingMore(false);
		}
	};

	if (loadError) {
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Could not load your sessions">
					{loadError}
				</EmptyState>
			</div>
		);
	}

	if (sessions === null) return <Loading label="Loading your sessions…" />;

	if (sessions.length === 0) {
		// Two different facts, and telling someone whose machines HAVE synced
		// to go connect one would be exactly the lie LessonsPage's own empty
		// states were built to avoid - see that page's comment on an empty
		// filter result and an empty pool.
		if (hasMachines === false) {
			return (
				<div style={{ maxWidth: "640px" }}>
					<EmptyState
						title="No machine has synced yet"
						icon="Sleep"
						tone="teal"
					>
						Sessions arrive once a machine using the CLI syncs its activity.{" "}
						<NavLink to="/machines" style={{ color: PALETTE.accent }}>
							Connect a machine
						</NavLink>{" "}
						to start.
					</EmptyState>
				</div>
			);
		}

		// `hasMachines === true` or `=== null` (the machines read itself
		// failed) land here together: neither can honestly claim "connect a
		// machine" is the fix, and this copy is true either way - a session
		// has to do enough to be worth a row, whether or not this page could
		// confirm a machine exists to produce one.
		return (
			<div style={{ maxWidth: "640px" }}>
				<EmptyState title="Nothing has cleared the threshold yet">
					Most sessions are a handful of commands and stay below the bar this
					page sets. Yours will show up here once one does real work.
				</EmptyState>
			</div>
		);
	}

	// Grouped the same way ActivityPage groups events: a Map keyed by day
	// rather than merging same-day sessions that are merely adjacent in
	// `sessions`, since two sessions from different machines can commit with
	// the same `started_at` second and arrive in either order.
	const groups = new Map<string, SessionSummary[]>();
	for (const session of sessions) {
		const day = dayKey(session.started_at);
		const existing = groups.get(day);
		if (existing) existing.push(session);
		else groups.set(day, [session]);
	}
	const days = [...groups.entries()].map(([day, daySessions]) => ({
		day,
		sessions: daySessions,
	}));

	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			{days.map((group) => (
				<Panel key={group.day} title={group.day} icon="Monitor">
					{group.sessions.map((session) => (
						<div
							key={session.session_id}
							style={{
								display: "flex",
								flexWrap: "wrap",
								gap: "var(--space-3)",
								padding: "0.35rem 0",
							}}
						>
							<span style={{ color: "var(--ink-dim)", flex: "none" }}>
								{timeOf(session.started_at)}
							</span>
							<span style={{ flex: "none" }}>
								{durationOf(session.started_at, session.ended_at)}
							</span>
							<span style={{ flex: "none" }}>
								{session.event_count.toLocaleString()} events
							</span>
							<span style={{ color: PALETTE.muted }}>
								{shapeOf(session.counts_by_prefix)}
							</span>
						</div>
					))}
				</Panel>
			))}

			<LoadMore
				cursor={cursor}
				loading={loadingMore}
				ended={ended}
				endLabel="That's the whole history."
				error={moreError}
				onLoadMore={() => void loadMore()}
			/>
		</div>
	);
}
