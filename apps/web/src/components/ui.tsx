import type { ReactNode } from "react";
import { PALETTE } from "./palette";

// The display half of the split form.tsx anticipated with "until a design
// system lands". form.tsx keeps the form primitives; these are the ones the
// lessons and machines pages read and act through. Both import the same
// PALETTE - see palette.ts for why that matters.

/** The four values the `status` column holds. A browser may only set two. */
export type LessonStatus = "active" | "retracted" | "refuted" | "superseded";

const STATUS_LABELS: Record<LessonStatus, string> = {
	active: "Active",
	retracted: "Retracted",
	refuted: "Refuted",
	superseded: "Superseded",
};

/**
 * The plate says whether the claim is in force; the word says why not. Three
 * plates for four statuses would invite the reader to decode a color that
 * carries no more than the label already does.
 */
export function StatusBadge({ status }: { status: LessonStatus }) {
	const inForce = status === "active";
	return (
		<span
			style={{
				display: "inline-block",
				// A filled badge needs a plate, not an accent: accents shift per
				// theme and no constant label ink reads on a ground that moves
				// under it. plate-ink holds at 8.32 on teal and 7.00 on red in
				// both themes, so no conditional is needed. See SubmitButton.
				background: inForce ? PALETTE.plateTeal : PALETTE.plateRed,
				color: PALETTE.plateInk,
				// Carried from inside for the same reason SubmitButton does it:
				// in day mode the plates go flat against --panel, and plate-ink
				// is what still has an edge there.
				border: `2px solid ${PALETTE.plateInk}`,
				borderRadius: 0,
				padding: "0.15rem 0.5rem",
				fontFamily: "var(--font-data)",
				fontSize: "var(--text-data-sm)",
				letterSpacing: "1px",
				textTransform: "uppercase",
				whiteSpace: "nowrap",
			}}
		>
			{STATUS_LABELS[status]}
		</span>
	);
}

/**
 * An outlined label for a fact that is not a status - a stack, a source, a
 * count. Outlined rather than filled so a row of chips beside a StatusBadge
 * does not compete with it.
 */
export function Chip({ children }: { children: ReactNode }) {
	return (
		<span
			style={{
				display: "inline-block",
				// ink-dim, not edge: this sits on --ground and on --panel in
				// different places, and edge only clears ~1.8-2.7 against panel.
				border: `2px solid ${PALETTE.border}`,
				color: PALETTE.muted,
				borderRadius: 0,
				padding: "0.1rem 0.45rem",
				fontFamily: "var(--font-body)",
				fontSize: "0.8rem",
				whiteSpace: "nowrap",
			}}
		>
			{children}
		</span>
	);
}

/** A bordered grouping. Untitled panels group without adding to the outline. */
export function Panel({
	title,
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	return (
		<section
			style={{
				background: "var(--panel)",
				border: `2px solid ${PALETTE.border}`,
				borderRadius: 0,
				padding: "1rem",
			}}
		>
			{title ? (
				<h2
					style={{
						margin: "0 0 0.75rem",
						fontFamily: "var(--font-data)",
						fontSize: "var(--text-data-md)",
						letterSpacing: "1px",
						textTransform: "uppercase",
					}}
				>
					{title}
				</h2>
			) : null}
			{children}
		</section>
	);
}

/**
 * The state the pool is in at launch, and the one it returns to whenever a
 * fetch fails. Designed rather than defaulted: an empty filter result and an
 * empty pool say different things, so the caller supplies both the title and
 * the explanation instead of getting one generic sentence.
 */
export function EmptyState({
	title,
	children,
	action,
}: {
	title: string;
	children?: ReactNode;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div
			style={{
				textAlign: "center",
				padding: "2rem 1rem",
				fontFamily: "var(--font-body)",
			}}
		>
			<h2
				style={{
					margin: "0 0 0.5rem",
					fontFamily: "var(--font-display)",
					fontSize: "var(--text-display-md)",
					letterSpacing: "1px",
				}}
			>
				{title}
			</h2>
			{children ? (
				<p style={{ color: PALETTE.muted, margin: "0 0 1rem" }}>{children}</p>
			) : null}
			{action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
		</div>
	);
}

/**
 * The non-form button. `SubmitButton` in form.tsx is the type="submit" one;
 * this is Retract, Revoke and Retry, several of which sit inside or beside a
 * form where a defaulted type would submit it instead of running the handler.
 *
 * Styling deliberately matches SubmitButton - same plates, same carried
 * border, same disabled treatment - so the two read as one control.
 */
export function Button({
	children,
	onClick,
	variant = "primary",
	loading,
	loadingLabel,
	disabled,
}: {
	children: ReactNode;
	onClick: () => void;
	variant?: "primary" | "danger";
	loading?: boolean;
	loadingLabel?: string;
	disabled?: boolean;
}) {
	// Pending is disabled, not merely labelled. Retract round-trips instead of
	// updating optimistically, so the button is live for as long as the request
	// takes and a second press would transition a lesson already moving.
	const isDisabled = loading || disabled;
	const plate = variant === "danger" ? PALETTE.plateRed : PALETTE.plateTeal;
	return (
		<button
			type="button"
			disabled={isDisabled}
			onClick={onClick}
			style={{
				padding: "0.5rem 1rem",
				background: isDisabled ? "var(--panel)" : plate,
				color: isDisabled ? "var(--ink)" : PALETTE.plateInk,
				border: isDisabled
					? "2px solid var(--ink-dim)"
					: `2px solid ${PALETTE.plateInk}`,
				boxShadow: isDisabled ? "none" : "4px 4px 0 var(--shadow)",
				borderRadius: 0,
				cursor: isDisabled ? "not-allowed" : "pointer",
				fontFamily: "var(--font-data)",
				fontSize: "var(--text-data-md)",
				letterSpacing: "1px",
				textTransform: "uppercase",
			}}
		>
			{loading ? (loadingLabel ?? "Working...") : children}
		</button>
	);
}
