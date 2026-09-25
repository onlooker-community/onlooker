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

import { type Rollup, formatDurationMs } from "../lib/sessionRollup";
import { PALETTE } from "./palette";
import { Panel } from "./ui";

export default function SessionsSummary({ rollup }: { rollup: Rollup }) {
	// Not an empty state - SessionsPage owns those, and its three variants say
	// different true things about machines. Rendering nothing lets them speak.
	if (rollup.sessions === 0) return null;

	const total = formatDurationMs(rollup.durationMs);
	const headline = rollup.complete
		? `${rollup.sessions.toLocaleString()} sessions`
		: `most recent ${rollup.sessions.toLocaleString()} sessions`;

	// Bars are relative to the busiest loaded day, so the tallest is always
	// full width. An absolute scale would render every bar as a sliver on a
	// quiet week.
	const busiest = Math.max(...rollup.days.map((d) => d.durationMs), 1);

	return (
		<Panel title="What you loaded" icon="Monitor">
			<div style={{ marginBottom: "var(--space-3)" }}>
				{headline}
				{total ? ` · ${total}` : ""}
				{rollup.range ? ` · ${rollup.range}` : ""}
			</div>

			{rollup.days.map((day) => (
				<div
					key={day.day}
					style={{
						display: "flex",
						alignItems: "center",
						gap: "var(--space-3)",
						padding: "0.2rem 0",
					}}
				>
					<span style={{ flex: "none", minWidth: "12rem" }}>
						{day.day}
					</span>
					<span
						aria-hidden="true"
						style={{
							flex: "none",
							height: "0.5rem",
							width: `${Math.max(2, (day.durationMs / busiest) * 100)}%`,
							maxWidth: "8rem",
							background: PALETTE.accent,
							borderRadius: "2px",
						}}
					/>
					<span style={{ color: PALETTE.muted }}>
						{day.sessions}{" "}
						{day.sessions === 1 ? "session" : "sessions"}
						{day.durationMs
							? ` · ${formatDurationMs(day.durationMs)}`
							: ""}
					</span>
				</div>
			))}

			{rollup.longest ? (
				<div style={{ marginTop: "var(--space-3)", color: PALETTE.muted }}>
					Longest{" "}
					{formatDurationMs(
						new Date(
							rollup.longest.ended_at ?? rollup.longest.started_at,
						).getTime() - new Date(rollup.longest.started_at).getTime(),
					)}
					{" · "}
					{rollup.longest.prompts.toLocaleString()} prompts
					{rollup.longest.compactions
						? ` · ${rollup.longest.compactions} compactions`
						: ""}
				</div>
			) : null}
		</Panel>
	);
}
