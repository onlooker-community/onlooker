/**
 * One session in the feed, as two lines with different weights.
 *
 * Before this, a session was a single `flex-wrap` row in which time, machine,
 * duration, prompts and the full event breakdown were all spans of equal
 * weight. The breakdown had no `flex: none`, so it took whatever width was
 * left and wrapped - which is why it LOOKED like a second line while being
 * the same line, and why nothing distinguished one session from the next.
 * See ONL-173.
 *
 * The split now says what each part is for. Line one is the session: when it
 * ran, how long, how much was asked of it. Line two is the evidence, dimmer
 * and indented, and subordinate on purpose - it is the thing you read after
 * deciding a session is worth reading about.
 *
 * Presentational: it decides nothing. SessionsPage owns the day grouping and
 * therefore owns whether the machine name is worth repeating; sessionRollup
 * owns the arithmetic.
 */

import { PALETTE } from "./palette";

/** How many event types line two names before it starts counting instead. */
export const SHAPE_LIMIT = 3;

export default function SessionRow({
	time,
	machineName,
	duration,
	running,
	facts,
	shown,
	hidden,
	hiddenCount,
	last,
}: {
	time: string;
	/**
	 * The machine, or null to say nothing about it.
	 *
	 * Null covers two different situations deliberately, because the row
	 * renders identically for both: the machines read has not landed yet (the
	 * two fetches are independent, so rows can render first), and the name
	 * would only repeat the row above. SessionsPage decides which.
	 */
	machineName: string | null;
	duration: string;
	/**
	 * Whether `duration` is reporting a live session rather than a finished
	 * one. Drives the accent, and is passed rather than inferred from the
	 * string so this component never has to parse prose it was handed.
	 */
	running: boolean;
	/** "1 prompt", "3 prompts · 1 compaction" - already pluralized. */
	facts: string;
	shown: string;
	hidden: string;
	hiddenCount: number;
	/** The last row in a day panel skips its border, which Panel supplies. */
	last: boolean;
}) {
	return (
		<div
			// Lets tests find the row itself rather than inferring it from a
			// child's `closest("div")`, which broke the moment this gained a
			// second element.
			data-testid="session-row"
			style={{
				padding: "var(--space-3) 0",
				borderBottom: last ? "none" : `2px solid ${PALETTE.border}`,
			}}
		>
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					alignItems: "baseline",
					gap: "var(--space-3)",
				}}
			>
				<span style={{ flex: "none" }}>{time}</span>
				{machineName ? (
					<span style={{ flex: "none", color: PALETTE.muted }}>
						{machineName}
					</span>
				) : null}
				{/*
				 * Pushes the metrics right so they line up into a column the eye
				 * can run down, which is most of what this change is for. It is
				 * `marginLeft: auto` on a flex-wrap row rather than a grid: when
				 * the viewport is too narrow the group wraps to its own line and
				 * sits left, instead of a grid column holding a width the screen
				 * does not have.
				 */}
				<span
					style={{
						marginLeft: "auto",
						display: "flex",
						gap: "var(--space-3)",
						flexWrap: "wrap",
					}}
				>
					<span
						style={{
							flex: "none",
							// The one value on this line describing the present
							// rather than the past, and previously indistinguishable
							// from "<1m".
							color: running ? PALETTE.accent : undefined,
						}}
					>
						{duration}
					</span>
					<span style={{ flex: "none", color: PALETTE.muted }}>{facts}</span>
				</span>
			</div>

			{shown ? (
				<div
					style={{
						marginTop: "0.15rem",
						paddingLeft: "var(--space-3)",
						color: PALETTE.muted,
						fontSize: "0.9em",
					}}
				>
					{shown}
					{hiddenCount > 0 ? (
						<>
							{" · "}
							{/*
							 * The tail lives in a title rather than being dropped: these
							 * counts appear nowhere else in the app, and before this the
							 * page showed every one of them. A title is a recovery path,
							 * not an affordance - invisible on touch, inconsistently
							 * announced - which is the accepted cost of not giving every
							 * row an expandable control.
							 */}
							<span title={hidden} style={{ cursor: "help" }}>
								+{hiddenCount} more
							</span>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
