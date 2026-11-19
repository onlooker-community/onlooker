/**
 * The home page's first panel: the last 7 days of sessions (ONL-298).
 *
 * Presentational, like SessionsSummary. HomePage decides which rows are in
 * the window and whether they are all of them; this states what it is given,
 * through the same rollups the Sessions page uses, so the two pages cannot
 * disagree about a number.
 */

import { Link } from "react-router-dom";
import type { LabelMap } from "../api/labelsApi";
import type { SessionSummary } from "../api/sessionsApi";
import { projectName } from "../lib/projectEntries";
import {
	formatDurationMs,
	plural,
	rollupProjects,
	rollupSessions,
} from "../lib/sessionRollup";
import DayBar from "./DayBar";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

export const TOP_REPOSITORIES = 3;

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
	const busiest = Math.max(
		...days.map((day) => byDay.get(day)?.durationMs ?? 0),
	);
	const total = formatDurationMs(rollup.durationMs);
	const top = rollupProjects(sessions).projects.slice(0, TOP_REPOSITORIES);

	const counted = plural(rollup.sessions, "session");
	const headline = complete
		? `${counted}${total ? ` · ${total}` : ""} in the last 7 days`
		: `most recent ${counted}${total ? ` · ${total}` : ""}`;

	return (
		<Panel title="Recent sessions" icon="Monitor">
			<div
				data-testid="home-sessions-headline"
				style={{ marginBottom: "var(--space-3)" }}
			>
				{headline}
			</div>

			{days.map((day) => (
				<DayBar
					key={day}
					label={day}
					sessions={byDay.get(day)?.sessions ?? 0}
					durationMs={byDay.get(day)?.durationMs ?? 0}
					busiestMs={busiest}
				/>
			))}

			{top.length > 0 ? (
				<ul
					data-testid="home-repositories"
					style={{
						margin: "var(--space-3) 0 0",
						padding: 0,
						listStyle: "none",
					}}
				>
					{top.map((project) => (
						<li key={`${project.machineId ?? ""}:${project.key}`}>
							{projectName(project.key, project.machineId, labels)} ·{" "}
							{plural(project.events, "event")}
						</li>
					))}
				</ul>
			) : null}

			{footer}
		</Panel>
	);
}
