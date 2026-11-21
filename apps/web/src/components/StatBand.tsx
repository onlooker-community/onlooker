/**
 * A row of big numbers, each with a short label under it.
 *
 * The numbers are the page's answer at a glance, so they take the display
 * face at its largest legal step. The sentence above them says the same
 * thing in words; this is for the reader who wants to see it, not read it.
 *
 * Presentational: it formats nothing. The caller hands it strings.
 */

import { PALETTE } from "./palette";

export interface Stat {
	value: string;
	label: string;
	/** Red value for something that went wrong. The label still says what. */
	danger?: boolean;
}

export default function StatBand({
	stats,
	label,
}: {
	stats: Stat[];
	/** Names the group for a screen reader. */
	label: string;
}) {
	return (
		<section
			aria-label={label}
			data-testid="stat-band"
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))",
				borderTop: `2px solid ${PALETTE.border}`,
				borderBottom: `2px solid ${PALETTE.border}`,
			}}
		>
			{stats.map((stat, index) => (
				<div
					key={stat.label}
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "var(--space-2)",
						// The first cell sits flush with the page's left edge, and the
						// rest are divided from the one before.
						padding:
							index === 0
								? "var(--space-4) var(--space-5) var(--space-4) 0"
								: "var(--space-4) var(--space-5)",
						borderLeft: index === 0 ? "none" : `2px solid ${PALETTE.border}`,
					}}
				>
					<span
						style={{
							fontFamily: "var(--font-display)",
							fontSize: "var(--text-display-xl)",
							lineHeight: 1,
							color: stat.danger ? PALETTE.danger : "var(--ink-hi)",
							overflowWrap: "anywhere",
						}}
					>
						{stat.value}
					</span>
					<span
						style={{
							fontSize: "var(--text-body-md)",
							color: PALETTE.muted,
						}}
					>
						{stat.label}
					</span>
				</div>
			))}
		</section>
	);
}
