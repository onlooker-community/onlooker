/**
 * The home page's Lessons panel: what happened to the reader's lessons in the
 * last 7 days (ONL-298).
 *
 * Presentational, like HomePluginsPanel. HomePage hands it the window's
 * events and whether they are all of them; the words for each event come
 * from lib/lessonActivity, which ActivityPage uses too.
 */

import { Link } from "react-router-dom";
import type { ActivityEvent } from "../api/lessonsApi";
import { dayKey } from "../lib/dayKey";
import {
	describeKind,
	describeLessonWeek,
	tallyActivity,
} from "../lib/lessonActivity";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/** How many of the week's events the panel names. */
export const LATEST_EVENTS = 3;

export default function HomeLessonsPanel({
	events,
	complete,
	feedEmpty,
}: {
	/** Already filtered to the window, newest first. */
	events: ActivityEvent[];
	/** False when more pages remain that may hold events in the window. */
	complete: boolean;
	/** True when the page read held no events at all, in or out of the window. */
	feedEmpty: boolean;
}) {
	const footer = (
		<p style={{ margin: "var(--space-3) 0 0" }}>
			<Link to="/activity" style={{ color: PALETTE.accent }}>
				All lesson activity
			</Link>
		</p>
	);

	if (events.length === 0) {
		return (
			<Panel title="Lessons" icon="Book">
				<p style={{ margin: 0, color: PALETTE.muted }}>
					{feedEmpty ? (
						<>
							No lesson activity yet. A machine publishes its approved lessons
							when it runs <code>onlooker sync</code>.
						</>
					) : (
						"No lesson activity in the last 7 days."
					)}
				</p>
				{footer}
			</Panel>
		);
	}

	// From the window, not the whole page: an event from weeks ago under a
	// "last 7 days" headline would contradict it.
	const latest = events.slice(0, LATEST_EVENTS);

	return (
		<Panel title="Lessons" icon="Book">
			<p data-testid="home-lessons-headline" style={{ margin: 0 }}>
				{describeLessonWeek(tallyActivity(events), complete)}
			</p>
			<ul
				data-testid="home-lessons"
				aria-label="Latest lesson activity"
				style={{
					margin: "var(--space-3) 0 0",
					padding: 0,
					listStyle: "none",
					borderTop: `2px solid ${PALETTE.border}`,
				}}
			>
				{latest.map((event) => (
					<li
						key={event.seq}
						style={{
							padding: "var(--space-3) 0",
							borderBottom: `2px solid ${PALETTE.border}`,
						}}
					>
						<Link to={`/lessons/${event.lesson_id}`}>{event.claim}</Link>
						{/* The day, not the time: the window spans seven of them. */}
						<div
							style={{
								marginTop: "0.15rem",
								color: PALETTE.muted,
								fontSize: "0.9em",
							}}
						>
							{describeKind(event.kind)} ·{" "}
							<time dateTime={event.at}>{dayKey(event.at)}</time>
						</div>
					</li>
				))}
			</ul>
			{footer}
		</Panel>
	);
}
