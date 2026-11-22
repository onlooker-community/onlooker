/**
 * The home page's first panel: the last 7 days of sessions (ONL-298).
 *
 * Presentational, like SessionsSummary. HomePage decides which rows are in
 * the window and whether they are all of them; this states what it is given,
 * through the same rollups the Sessions page uses, so the two pages cannot
 * disagree about a number.
 */

import { Link } from "react-router-dom";
import { type LabelMap, labelIdentity } from "../api/labelsApi";
import type { SessionSummary } from "../api/sessionsApi";
import { dayKey } from "../lib/dayKey";
import { failuresIn } from "../lib/homeFailures";
import {
	countedSessions,
	formatDurationMs,
	plural,
	rollupProjects,
	rollupSessions,
} from "../lib/sessionRollup";
import DayBar from "./DayBar";
import { RepositoryName } from "./ProjectName";
import { PALETTE } from "./palette";
import { AllSpawned, SpawnedTail } from "./SpawnedSessions";
import StatBand, { type Stat } from "./StatBand";
import { Caption, Lead, LeadValue, Panel, Plate } from "./ui";

export const TOP_REPOSITORIES = 3;

/** How many failures "Worth a look" names before it says there are more. */
export const WORTH_A_LOOK = 3;

const TWO_UP = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))",
} as const;

/** "once", "twice", "3 times" - a failure count as a person would say it. */
function times(count: number): string {
	return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

function capitalized(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

export default function HomeSessionsPanel({
	sessions,
	complete,
	days,
	labels,
}: {
	/** Already filtered to the window. */
	sessions: SessionSummary[];
	/** False when more pages remain that may hold sessions in the window. */
	complete: boolean;
	/** The window's day labels, today first - see windowDays. */
	days: string[];
	labels: LabelMap;
}) {
	const footer = (
		<p style={{ margin: "var(--space-3) 0 0" }}>
			<Link to="/sessions" style={{ color: PALETTE.accent }}>
				All sessions
			</Link>
		</p>
	);

	if (sessions.length === 0) {
		return (
			<Panel title="Recent sessions" icon="Monitor">
				<p style={{ margin: 0, color: PALETTE.muted }}>
					No sessions in the last 7 days. A machine reports its sessions when it
					runs <code>onlooker sync</code>.
				</p>
				{footer}
			</Panel>
		);
	}

	const rollup = rollupSessions(sessions, !complete);
	const byDay = new Map(rollup.days.map((day) => [day.day, day]));
	// Capped, the pages not loaded are older than every loaded row, so a day
	// before the oldest loaded one is unknown rather than empty. Taken from
	// every loaded row, not `rollup.days`: a day only spawned sessions held
	// was still read, and has no entry there (ONL-304).
	const oldestStart = sessions.reduce(
		(oldest, s) => (s.started_at < oldest ? s.started_at : oldest),
		sessions[0].started_at,
	);
	const oldestLoaded = dayKey(oldestStart);
	const oldestIndex = days.indexOf(oldestLoaded);
	const drawn =
		complete || oldestIndex < 0 ? days : days.slice(0, oldestIndex + 1);
	const busiest = Math.max(
		...drawn.map((day) => byDay.get(day)?.durationMs ?? 0),
	);
	const total = formatDurationMs(rollup.durationMs);
	const top = rollupProjects(sessions).projects.slice(0, TOP_REPOSITORIES);

	const counted = plural(rollup.sessions, "session");

	// A sentence rather than a label. The numbers are the same ones the old
	// headline carried, from the same rollup; only the wording changed, so the
	// Sessions page and this one still cannot disagree about them. A capped
	// read says "most recent" for the reason SessionsSummary does: the rows
	// loaded are not the whole window, and a total would claim they are.
	const tail = total ? (
		<>
			, <LeadValue>{total}</LeadValue> in all
		</>
	) : null;

	// The day the most time went to, said only when one day holds it. A tie, or
	// a window with no time in it, has no busiest day, and naming one would be a
	// pick. Capped, the loaded days are all that was compared.
	const busyDays = drawn.filter(
		(day) => (byDay.get(day)?.durationMs ?? 0) === busiest,
	);
	const dayCaption =
		busiest > 0 && busyDays.length === 1
			? complete
				? `The busiest day was ${busyDays[0]}.`
				: `Of the days loaded, the busiest was ${busyDays[0]}.`
			: "Time reported each day, newest first.";

	// Over the same sessions as the count beside it, as the Sessions page does.
	const failures = failuresIn(countedSessions(sessions));
	const worth = failures.notes.slice(0, WORTH_A_LOOK);
	const stats: Stat[] = [
		{
			value: rollup.sessions.toLocaleString(),
			label: rollup.sessions === 1 ? "session" : "sessions",
		},
		...(total ? [{ value: total, label: "of session time" }] : []),
		{
			value: failures.total.toLocaleString(),
			label: failures.total === 1 ? "plugin failure" : "plugin failures",
			danger: failures.total > 0,
		},
	];

	// A block rather than a fragment: a grid parent would not collapse the
	// lead's own bottom margin into its gap, and the band would sit twice as
	// far from it as the mockup has it.
	return (
		<div>
			<Lead testId="home-sessions-headline">
				{rollup.sessions === 0 ? (
					<AllSpawned
						n={rollup.subordinate}
						complete={complete}
						intro="In the last 7 days your machines reported"
					/>
				) : complete ? (
					<>
						In the last 7 days your machines reported{" "}
						<LeadValue>{counted}</LeadValue>
						{tail}.
						<SpawnedTail n={rollup.subordinate} />
					</>
				) : (
					<>
						The most recent <LeadValue>{counted}</LeadValue> your machines
						reported{tail}.
						<SpawnedTail n={rollup.subordinate} />
					</>
				)}
			</Lead>

			<StatBand
				label={
					complete ? "The last 7 days in numbers" : "The most recent sessions"
				}
				stats={stats}
			/>

			<div
				style={{
					...TWO_UP,
					gap: "var(--space-7)",
					marginTop: "var(--space-7)",
				}}
			>
				<Panel title="Day by day" icon="Monitor" open>
					<Caption>{dayCaption}</Caption>
					{drawn.map((day) => (
						<DayBar
							key={day}
							label={day}
							sessions={byDay.get(day)?.sessions ?? 0}
							durationMs={byDay.get(day)?.durationMs ?? 0}
							busiestMs={busiest}
						/>
					))}
					{drawn.length < days.length ? (
						<p
							style={{
								margin: "var(--space-2) 0 0",
								color: PALETTE.muted,
								fontSize: "0.85em",
							}}
						>
							Older days not loaded.
						</p>
					) : null}
				</Panel>

				{top.length > 0 ? (
					<Panel title="Top repositories" icon="Document" open>
						<Caption>
							{complete
								? "Where the events came from in the last 7 days."
								: "Where the events in the loaded sessions came from."}
						</Caption>
						<ul
							data-testid="home-repositories"
							aria-label="Top repositories"
							style={{
								margin: 0,
								padding: 0,
								listStyle: "none",
								borderTop: `2px solid ${PALETTE.border}`,
							}}
						>
							{top.map((project) => (
								<li
									key={`${project.machineId ?? ""}:${project.key}`}
									style={{
										padding: "var(--space-3) 0",
										borderBottom: `2px solid ${PALETTE.border}`,
									}}
								>
									<RepositoryName
										project={{ key: project.key, machineId: project.machineId }}
										name={
											labels.get(
												labelIdentity(project.key, project.machineId),
											) ?? null
										}
									/>{" "}
									· {plural(project.events, "event")}
								</li>
							))}
						</ul>
					</Panel>
				) : null}
			</div>

			{worth.length > 0 ? (
				<div style={{ marginTop: "var(--space-7)" }}>
					<Panel title="Worth a look" icon="Eye" open>
						<div
							data-testid="home-worth-a-look"
							style={{ ...TWO_UP, gap: "var(--space-4)" }}
						>
							{worth.map((note) => (
								<div
									key={`${note.session.session_id}:${note.plugin}`}
									style={{
										display: "flex",
										gap: "var(--space-4)",
										alignItems: "flex-start",
										background: "var(--panel)",
										border: `2px solid ${PALETTE.border}`,
										padding: "var(--space-4)",
									}}
								>
									<Plate tone="red" icon="Plug" />
									<p style={{ margin: 0, lineHeight: 1.55 }}>
										{`${capitalized(note.plugin)} failed ${times(note.count)} in a session on ${dayKey(note.session.started_at)}. `}
										<Link to="/sessions" style={{ color: PALETTE.accent }}>
											Open Sessions
										</Link>
									</p>
								</div>
							))}
						</div>
						{failures.notes.length > worth.length ? (
							<p style={{ margin: "var(--space-3) 0 0", color: PALETTE.muted }}>
								{`${failures.notes.length - worth.length} more not shown.`}
							</p>
						) : null}
					</Panel>
				</div>
			) : null}

			<div style={{ marginTop: "var(--space-5)" }}>{footer}</div>
		</div>
	);
}
