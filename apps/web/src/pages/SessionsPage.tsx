import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { listMachines } from "../api/machinesApi";
import { listSessions, type SessionSummary } from "../api/sessionsApi";
import { LoadMore } from "../components/LoadMore";
import { PALETTE } from "../components/palette";
import SessionsSummary from "../components/SessionsSummary";
import { EmptyState, Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { dayKey, timeOf } from "../lib/dayKey";
import { formatDurationMs, rollupSessions } from "../lib/sessionRollup";

// A person's own read of the CLI sessions their machines have reported -
// every row here already cleared apps/cli's reporting threshold, so unlike
// ActivityPage this page never has to filter what it shows. See
// sessionsApi.ts's SessionsPage doc comment.

/** How long a session ran, or that it is still running. */
function durationOf(startedAt: string, endedAt: string | null): string {
	if (!endedAt) return "Still running";
	return formatDurationMs(
		new Date(endedAt).getTime() - new Date(startedAt).getTime(),
	);
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

/**
 * The machines read, as a real three-state rather than `boolean | null`
 * standing in for both "still in flight" and "failed." Those are different
 * facts and a type that cannot tell them apart lets a render read one as the
 * other - which is exactly what happened here: gating only on
 * `sessions === null` let a `hasMachines === false` check run against the
 * `null` default while the real read was still out, so an account with zero
 * machines flashed "Nothing has cleared the threshold yet" before correcting
 * itself to "No machine has synced yet" a moment later. Both empty states
 * below assert something about machines, so neither may render until this is
 * `"known"` or `"failed"` - see the two guards ahead of them.
 */
type MachinesCheck =
	| { kind: "pending" }
	| { kind: "known"; hasMachines: boolean }
	| { kind: "failed" };

export default function SessionsPage() {
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [machinesCheck, setMachinesCheck] = useState<MachinesCheck>({
		kind: "pending",
	});
	const [machinesError, setMachinesError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [moreError, setMoreError] = useState<string | null>(null);
	const [ended, setEnded] = useState(false);
	const [hasMore, setHasMore] = useState(false);

	// A second, independent read, kept apart from the sessions fetch rather
	// than folded into one Promise.all: a failure here says nothing about
	// whether the session history loaded, and coupling the two would turn an
	// unrelated machines-list error into a full page failure for a person
	// whose sessions came back fine. Its own `useCallback` rather than inline
	// in the mount effect below, so the "Could not check your machines" empty
	// state (rendered when `machinesCheck.kind === "failed"`) can offer a
	// Retry that runs the exact same read rather than a second copy of it.
	//
	// `hasMachines` asks whether any machine has actually synced, not whether
	// one was ever minted: `machines` here is every token this account has
	// ever created, revoked ones included, and `last_used_at` stays null until
	// a token is actually presented by `sync` (see `verifyMachineToken` in
	// apps/api's machine-tokens.ts). Reading `machines.length > 0` for this
	// answers "has this account ever minted a token," which is a different
	// fact - mint one, never run sync, and that read is true while no session
	// could possibly exist yet, sending someone to the threshold copy below
	// instead of the "no machine has synced yet" state that is actually true.
	//
	// `isActive` defaults to always-true for the Retry button's call - a click
	// only happens while mounted - and is threaded through by the mount effect
	// below with its own `active` flag, the same one already guarding its two
	// sibling setters, so a `listMachines()` that resolves after unmount does
	// not set state on a page that is gone.
	const checkMachines = useCallback(
		async (isActive: () => boolean = () => true) => {
			setMachinesCheck({ kind: "pending" });
			setMachinesError(null);
			try {
				const { machines } = await listMachines();
				if (!isActive()) return;
				setMachinesCheck({
					kind: "known",
					hasMachines: machines.some(
						(m) => m.revoked_at === null && m.last_used_at !== null,
					),
				});
			} catch (error) {
				if (!isActive()) return;
				setMachinesCheck({ kind: "failed" });
				setMachinesError(
					describeError(error, "Could not check your machines."),
				);
			}
		},
		[],
	);

	useEffect(() => {
		// An `active` flag, not a request sequence number - this screen has no
		// filter to mint a second query, so the only thing to guard against is
		// an unmount mid-flight. Same reasoning as ActivityPage's own effect.
		let active = true;
		listSessions({ limit: 200 })
			.then((page) => {
				if (!active) return;
				setSessions(page.sessions);
				setCursor(page.has_more ? page.cursor : null);
				setHasMore(page.has_more);
			})
			.catch((error: unknown) => {
				if (!active) return;
				setLoadError(describeError(error, "Could not load your sessions."));
			});
		void checkMachines(() => active);
		return () => {
			active = false;
		};
	}, [checkMachines]);

	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const page = await listSessions({ cursor });
			setSessions((current) => [...(current ?? []), ...page.sessions]);
			setCursor(page.has_more ? page.cursor : null);
			setEnded(!page.has_more);
			setHasMore(page.has_more);
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
		// Not yet known which empty state is true. Both assert a fact about
		// machines, and rendering either one now would be a guess dressed up
		// as an answer - the exact failure mode this type exists to close off.
		// A moment more of loading is the honest cost; see MachinesCheck.
		if (machinesCheck.kind === "pending") {
			return <Loading label="Loading your sessions…" />;
		}

		// The read that would settle this failed outright. Neither empty state
		// is safe to guess at - one claims no machine exists, the other claims
		// some do but none cleared the threshold - so this gets its own honest
		// wording rather than defaulting to either, plus a way to try again
		// through the exact same read (`checkMachines`, not a second copy).
		if (machinesCheck.kind === "failed") {
			return (
				<div style={{ maxWidth: "640px" }}>
					<EmptyState
						title="Could not check your machines"
						action={{ label: "Retry", onClick: () => void checkMachines() }}
					>
						{machinesError}
					</EmptyState>
				</div>
			);
		}

		// Two different facts, and telling someone whose machines HAVE synced
		// to go connect one would be exactly the lie LessonsPage's own empty
		// states were built to avoid - see that page's comment on an empty
		// filter result and an empty pool.
		if (!machinesCheck.hasMachines) {
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
			<SessionsSummary rollup={rollupSessions(sessions, hasMore)} />

			{days.map((group) => (
				<Panel key={group.day} title={group.day} icon="Monitor">
					{group.sessions.map((session) => (
						<div
							// `session_id` alone is not unique across the feed - it spans
							// every machine this account has, and two machines can each
							// mint their own session id independently.
							key={`${session.machine_id}:${session.session_id}`}
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
								{session.prompts.toLocaleString()}{" "}
								{session.prompts === 1 ? "prompt" : "prompts"}
							</span>
							{session.compactions ? (
								<span style={{ flex: "none" }}>
									{session.compactions}{" "}
									{session.compactions === 1 ? "compaction" : "compactions"}
								</span>
							) : null}
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
				// Not "the whole history" - the server only keeps 180 days of it
				// (see RETENTION_DAYS, apps/api's session-summaries.ts), so this
				// names the actual boundary rather than a claim the data doesn't
				// back.
				endLabel="That's the last 180 days of history."
				error={moreError}
				onLoadMore={() => void loadMore()}
			/>
		</div>
	);
}
