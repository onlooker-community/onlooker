import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
	type LabelMap,
	labelIdentity,
	listLabels,
	setLabel,
} from "../api/labelsApi";
import { listMachines, type Machine } from "../api/machinesApi";
import { listSessions, type SessionSummary } from "../api/sessionsApi";
import { LoadMore } from "../components/LoadMore";
import { PALETTE } from "../components/palette";
import RepositoriesSummary from "../components/RepositoriesSummary";
import SessionRow, { REPO_LIMIT, SHAPE_LIMIT } from "../components/SessionRow";
import SessionsSummary from "../components/SessionsSummary";
import { EmptyState, Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";
import { timeOf } from "../lib/dayKey";
import { pluginActivity } from "../lib/pluginActivity";
import {
	durationMsOf,
	formatDurationMs,
	groupSessionsByDay,
	plural,
	rollupProjects,
	rollupSessions,
	topShape,
} from "../lib/sessionRollup";

// A person's own read of the CLI sessions their machines have reported -
// every row here already cleared apps/cli's reporting threshold, so unlike
// ActivityPage this page never has to filter what it shows. See
// sessionsApi.ts's SessionsPage doc comment.

/** How long a session ran, or that it is still running. */
function durationOf(startedAt: string, endedAt: string | null): string {
	if (!endedAt) return "Still running";
	const ms = durationMsOf({ started_at: startedAt, ended_at: endedAt });
	return ms === null ? "" : formatDurationMs(ms);
}

/**
 * What a row says about volume, after its time and duration.
 *
 * Joined here rather than rendered as separate spans because they are one
 * fact - how much was asked of this session - and splitting them would put
 * two gaps in the metrics column that the eye reads as columns of their own.
 */
function factsOf(session: SessionSummary): string {
	const prompts = plural(session.prompts, "prompt");
	return session.compactions
		? `${prompts} · ${plural(session.compactions, "compaction")}`
		: prompts;
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
	| { kind: "known"; machines: Machine[] }
	| { kind: "failed" };

/**
 * Whether any machine on this account has ever reported.
 *
 * Derived rather than stored, so the one read answers both questions it is
 * needed for - which empty state is true, and what to call the machine a row
 * came from.
 *
 * Revoked machines COUNT. The question is about the past, and revoking a
 * token stops it reporting anything new rather than un-sending what it
 * already sent. Excluding them told someone whose only machine had synced,
 * stayed under the threshold, and was later revoked to go connect a machine -
 * advice that is both false and useless. See onlooker-kipn.3.
 */
function hasSynced(machines: Machine[]): boolean {
	return machines.some((m) => m.last_used_at !== null);
}

/**
 * What to call the machine a session came from.
 *
 * Sessions outlive the machines that reported them: revoke or delete a token
 * and the history it already sent stays in the feed. The id the API returns
 * is a token id rather than a name, so echoing it would be noise - this says
 * the name is gone instead of pretending an id is one.
 */
function machineName(machines: Machine[], machineId: string): string {
	return machines.find((m) => m.id === machineId)?.name ?? "unknown machine";
}

/**
 * A session's events per repository, under the user's names where they
 * gave one (ONL-189).
 *
 * Summed rather than overwritten when two keys share a name: someone who
 * named an https clone and an ssh clone of one repository the same has said
 * they are one, and the line should not drop half the events to disagree.
 */
function reposOf(
	session: SessionSummary,
	labels: LabelMap,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [key, { basis, event_count }] of Object.entries(
		session.counts_by_project,
	)) {
		const machineId = basis === "root" ? session.machine_id : null;
		const name = labels.get(labelIdentity(key, machineId)) ?? key;
		counts[name] = (counts[name] ?? 0) + event_count;
	}
	return counts;
}

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
	// Empty until read, and empty if the read fails: every key then shows as
	// itself, which is what this page showed before names existed. Not worth
	// an error state of its own - nothing on the page is wrong without them.
	const [labels, setLabels] = useState<LabelMap>(new Map());

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
				setMachinesCheck({ kind: "known", machines });
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
		listLabels()
			.then((loaded) => {
				if (active) setLabels(loaded);
			})
			.catch(() => {
				// Deliberately quiet; see the state's own comment.
			});
		return () => {
			active = false;
		};
	}, [checkMachines]);

	// Applies what the server stored - trimmed - rather than what was typed,
	// and only once it is stored: a refused name never shows as if it took.
	const rename = async (
		project: { key: string; machineId: string | null },
		label: string | null,
	) => {
		const stored = await setLabel(project.key, project.machineId, label);
		setLabels((current) => {
			const next = new Map(current);
			const identity = labelIdentity(project.key, project.machineId);
			if (stored === null) next.delete(identity);
			else next.set(identity, stored);
			return next;
		});
	};

	const loadMore = async () => {
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		setMoreError(null);
		try {
			const page = await listSessions({ cursor, limit: 200 });
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
		if (!hasSynced(machinesCheck.machines)) {
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

	return (
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
			<SessionsSummary rollup={rollupSessions(sessions, hasMore)} />
			<RepositoriesSummary
				rollup={rollupProjects(sessions)}
				complete={!hasMore}
				machineName={(id) =>
					machinesCheck.kind === "known"
						? machineName(machinesCheck.machines, id)
						: null
				}
				nameOf={(project) =>
					labels.get(labelIdentity(project.key, project.machineId)) ?? null
				}
				onRename={rename}
			/>

			{/* Same grouping rollupSessions's own day totals use - see
			    groupSessionsByDay's doc comment in sessionRollup.ts for why a
			    Map keyed by day is used rather than merging same-day sessions
			    that are merely adjacent in `sessions`. Sharing the function
			    keeps the header's day order and this feed's day order
			    structurally identical rather than independently maintained. */}
			{groupSessionsByDay(sessions).map((group) => (
				<Panel key={group.day} title={group.day} icon="Monitor">
					{group.sessions.map((session, index) => {
						const name =
							machinesCheck.kind === "known"
								? machineName(machinesCheck.machines, session.machine_id)
								: null;

						// Repeated only where it carries information. A
						// single-machine account otherwise prints the same word
						// down the whole feed, which is a column of noise between
						// the time and the metrics. The first row of a day always
						// says it, so no panel ever opens without naming the
						// machine its sessions came from - the comparison is
						// within this group rather than across the feed for
						// exactly that reason.
						const previous = index > 0 ? group.sessions[index - 1] : null;
						const repeats =
							previous !== null && previous.machine_id === session.machine_id;

						const shape = topShape(session.counts_by_prefix, SHAPE_LIMIT);
						const repos = topShape(reposOf(session, labels), REPO_LIMIT);

						return (
							<SessionRow
								// `session_id` alone is not unique across the feed - it
								// spans every machine this account has, and two machines
								// can each mint their own session id independently.
								key={`${session.machine_id}:${session.session_id}`}
								time={timeOf(session.started_at)}
								// Null while the machines read is in flight or failed, and
								// again when the name would only repeat the row above. The
								// row renders identically for all three, which is why one
								// nullable value carries them rather than a flag per case.
								machineName={repeats ? null : name}
								duration={durationOf(session.started_at, session.ended_at)}
								running={session.ended_at === null}
								facts={factsOf(session)}
								shown={shape.shown}
								hidden={shape.hidden}
								hiddenCount={shape.hiddenCount}
								activity={pluginActivity(session.counts_by_type, SHAPE_LIMIT)}
								repos={repos}
								repoCount={Object.keys(session.counts_by_project).length}
								last={index === group.sessions.length - 1}
							/>
						);
					})}
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
