/**
 * What the sessions page loaded, summarized.
 *
 * This component states only what the rollup counted. When `complete` is
 * false the wording changes from a total to "the most recent N" - the numbers
 * are the same either way, and the difference is whether the page is claiming
 * they describe the account's whole history. The fetch is newest-first across
 * all time rather than a calendar query, so "this week" is a claim the data
 * cannot back; the range says which dates the loaded rows actually span.
 *
 * Presentational: it decides nothing. lib/sessionRollup.ts does the
 * arithmetic, and SessionsPage decides whether this renders at all.
 */

import { formatDurationMs, plural, type Rollup } from "../lib/sessionRollup";
import DayBar from "./DayBar";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

/**
 * Show at most this many day rows. Against 180 days of retention an
 * unbounded list stacks one bar per day above the feed; the totals line
 * above keeps describing everything loaded, so capping the rows is
 * presentational only and never changes the numbers this component states.
 */
const MAX_VISIBLE_DAYS = 7;

export default function SessionsSummary({ rollup }: { rollup: Rollup }) {
	// Not an empty state - SessionsPage owns those, and its three variants say
	// different true things about machines. Rendering nothing lets them speak.
	if (rollup.sessions === 0) return null;

	const total = formatDurationMs(rollup.durationMs);
	const headline = rollup.complete
		? plural(rollup.sessions, "session")
		: `most recent ${plural(rollup.sessions, "session")}`;

	const visibleDays = rollup.days.slice(0, MAX_VISIBLE_DAYS);
	const hiddenDayCount = rollup.days.length - visibleDays.length;

	// Bars are relative to the busiest VISIBLE day, so the tallest among the
	// rows actually on screen is always full width, regardless of whether a
	// busier day got capped out of view.
	const busiest = Math.max(...visibleDays.map((d) => d.durationMs), 1);

	return (
		<Panel title="What you loaded" icon="Monitor">
			<div
				// Per-day rows also render "N sessions", so position-based queries
				// break if Panel's structure changes. The attribute names what the
				// test needs, independent of Panel's internal organization.
				data-testid="sessions-headline"
				style={{ marginBottom: "var(--space-3)" }}
			>
				{headline}
				{total ? ` · ${total}` : ""}
				{rollup.range ? ` · ${rollup.range}` : ""}
			</div>

			{visibleDays.map((day) => (
				<DayBar
					key={day.day}
					label={day.day}
					sessions={day.sessions}
					durationMs={day.durationMs}
					busiestMs={busiest}
				/>
			))}

			{hiddenDayCount > 0 ? (
				<div style={{ padding: "0.2rem 0", color: PALETTE.muted }}>
					… {plural(hiddenDayCount, "more day")}
				</div>
			) : null}

			{rollup.longest && rollup.longestMs !== null ? (
				<div style={{ marginTop: "var(--space-3)", color: PALETTE.muted }}>
					Longest {formatDurationMs(rollup.longestMs)}
					{" · "}
					{plural(rollup.longest.prompts, "prompt")}
					{rollup.longest.compactions
						? ` · ${plural(rollup.longest.compactions, "compaction")}`
						: ""}
				</div>
			) : null}
		</Panel>
	);
}
