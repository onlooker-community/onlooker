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

import type { PluginActivity } from "../lib/pluginActivity";
import type { Shape } from "../lib/sessionRollup";
import { PALETTE } from "./palette";

/** How many event types line two names before it starts counting instead. */
export const SHAPE_LIMIT = 3;

/**
 * How many repositories the repository line names. Two, not three: a key is
 * twelve characters of hex against an event type's one word, and 83% of
 * sessions touch only one repository anyway.
 */
export const REPO_LIMIT = 2;

/**
 * One evidence line: the largest counts, then the tail in a title.
 *
 * Shared by the event breakdown and the repository line so the two cannot
 * drift into different ways of saying "and N more".
 */
const EVIDENCE_STYLE = {
	marginTop: "0.15rem",
	paddingLeft: "var(--space-3)",
	color: PALETTE.muted,
	fontSize: "0.9em",
} as const;

function Breakdown({
	shape,
	testId,
	label,
}: {
	shape: Shape;
	testId?: string;
	/** Names what the counts are of, for a line that is not about plugins. */
	label?: string;
}) {
	return (
		<div data-testid={testId} style={EVIDENCE_STYLE}>
			{label ? `${label}: ` : null}
			{shape.shown}
			{shape.hiddenCount > 0 ? (
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
					<span title={shape.hidden} style={{ cursor: "help" }}>
						+{shape.hiddenCount} more
					</span>
				</>
			) : null}
		</div>
	);
}

/**
 * What each plugin did, output first (ONL-190).
 *
 * Three lines at most, each only when it has something to say: what was
 * produced, which plugins ran without producing, and which failed. The
 * quiet plugins are named and not counted - "curator ran twice and found
 * nothing" is the point, and a count of its start and complete events would
 * read as work done, which is what the prefix line got wrong.
 */
function Activity({ activity }: { activity: PluginActivity }) {
	const quiet = [
		activity.idle.length > 0 ? `ran idle: ${activity.idle.join(", ")}` : null,
		activity.skipped.length > 0
			? `skipped: ${activity.skipped.join(", ")}`
			: null,
		activity.unclassified.length > 0
			? `unclassified: ${activity.unclassified.join(", ")}`
			: null,
	].filter((part) => part !== null);

	// The per-type counts are present and every one of them was the harness.
	// Said rather than left blank, because a row that ends after line one
	// reads as missing data, and this is a finding (ONL-196).
	if (
		!activity.produced.shown &&
		quiet.length === 0 &&
		activity.failed.length === 0
	) {
		return (
			<div data-testid="session-no-plugins" style={EVIDENCE_STYLE}>
				no plugin activity
			</div>
		);
	}

	return (
		<>
			{activity.produced.shown ? (
				<Breakdown shape={activity.produced} testId="session-produced" />
			) : null}
			{quiet.length > 0 ? (
				<div data-testid="session-quiet" style={EVIDENCE_STYLE}>
					{quiet.join(" · ")}
				</div>
			) : null}
			{activity.failed.length > 0 ? (
				<div
					data-testid="session-failed"
					style={{ ...EVIDENCE_STYLE, color: PALETTE.danger }}
				>
					{/* The word "failed" carries it for a screen reader. */}
					<span aria-hidden="true">✕ </span>
					{activity.failed
						.map(({ plugin, count }) => `${plugin} failed ${count}×`)
						.join(" · ")}
				</div>
			) : null}
		</>
	);
}

export default function SessionRow({
	time,
	machineName,
	duration,
	running,
	facts,
	shown,
	hidden,
	hiddenCount,
	activity,
	repos,
	repoCount,
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
	/**
	 * What each plugin did, or null for a session synced before per-type
	 * counts existed - which keeps the prefix line (`shown`) instead.
	 */
	activity: PluginActivity | null;
	/**
	 * Events per repository, as project keys. An empty `shown` renders no
	 * line at all: a session that carried no key has nothing true to say
	 * here, and "no repository" on every pre-2.7.0 row would be noise.
	 */
	repos: Shape;
	/**
	 * How many repositories `repos` covers, shown and hidden, so the label can
	 * say "repo" or "repos" without parsing the line it labels.
	 */
	repoCount: number;
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

			{activity ? (
				<Activity activity={activity} />
			) : shown ? (
				<Breakdown shape={{ shown, hidden, hiddenCount }} />
			) : null}
			{repos.shown ? (
				<Breakdown
					shape={repos}
					testId="session-repos"
					// Labeled because it sits under the plugin lines in the same
					// style, and "95 6a7678979e31" otherwise reads as one more
					// plugin count (ONL-196).
					label={repoCount === 1 ? "repo" : "repos"}
				/>
			) : null}
		</div>
	);
}
