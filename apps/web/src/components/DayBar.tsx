/**
 * One day's row: its label, a bar for its time, and its counts.
 *
 * Pulled out of SessionsSummary so the home page draws days the same way the
 * Sessions page does (ONL-298). The comments below came with it.
 */

import { formatDurationMs, plural } from "../lib/sessionRollup";
import { PALETTE } from "./palette";

export default function DayBar({
	label,
	sessions,
	durationMs,
	busiestMs,
}: {
	label: string;
	sessions: number;
	durationMs: number;
	/** The longest day on screen, so the busiest bar is full width. */
	busiestMs: number;
}) {
	// A 2% floor keeps a day that had sessions visible, however short. A day
	// with none gets an empty track instead: the home panel draws every day of
	// its window, and a sliver there would claim work that did not happen.
	const width =
		sessions === 0
			? 0
			: Math.max(2, (durationMs / Math.max(busiestMs, 1)) * 100);

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: "var(--space-3)",
				padding: "0.2rem 0",
				// Without this the row cannot fit a phone. The label and the
				// track below are rigid - 12rem and 8rem - and with two 12px
				// gaps they claim 344px before the counts get a single pixel,
				// so on anything narrower the counts span was squeezed to a
				// sliver and wrapped its own text instead: "5 sessions · 44m"
				// became three stacked lines reading "5", "sessions", "· 44m".
				// Wrapping moves the whole span to its own line instead of
				// crushing it. See ONL-174.
				flexWrap: "wrap",
			}}
		>
			{/*
			 * `0 1 12rem` rather than `none` + `minWidth`. The basis is what
			 * aligns every bar into a column at full width - the entire point
			 * of this panel is comparing them - and it is identical to the old
			 * fixed width whenever the row has room. The difference is only at
			 * widths narrower than the label itself, where `none` would
			 * overflow the panel and this shrinks and wraps the date instead.
			 */}
			<span style={{ flex: "0 1 12rem" }}>{label}</span>
			<span
				aria-hidden="true"
				style={{
					// Shrinkable for the same reason, and safe: the fill inside
					// is a percentage of this track, so a narrower track scales
					// every bar by the same factor and leaves them comparable.
					flex: "0 1 8rem",
					height: "0.5rem",
					// No background here on purpose: PALETTE.track is
					// --panel, the same fill this Panel sits on, so a
					// filled track would paint nothing (form.tsx hit
					// this identical pair and documented it). The
					// border bounds the track's full extent instead, so
					// a quiet day's sliver of a bar still reads as a
					// sliver inside a knowable length rather than
					// floating on nothing.
					border: "2px solid var(--ink-dim)",
					borderRadius: "2px",
				}}
			>
				<span
					data-testid="day-bar-fill"
					style={{
						display: "block",
						height: "100%",
						width: `${width}%`,
						background: PALETTE.accent,
						borderRadius: "2px",
					}}
				/>
			</span>
			<span style={{ color: PALETTE.muted }}>
				{plural(sessions, "session")}
				{durationMs ? ` · ${formatDurationMs(durationMs)}` : ""}
			</span>
		</div>
	);
}
