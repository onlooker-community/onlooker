import type { IconName } from "@onlooker/brand";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
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
 * `Restart` for superseded - the claim run again rather than thrown away, which
 * is why it is not Trashbin. Recorded in the brand doc with the rest of the
 * mapping.
 *
 * Exported rather than kept local to `StatusBadge`: the list row's leading
 * plate and the detail pane's header both render this same icon themselves,
 * beside the badge rather than inside it - see the note on `StatusBadge`
 * below for why. One mapping, three renderers, so none of them can drift on
 * what a status means.
 */
export const STATUS_ICONS: Record<LessonStatus, IconName> = {
	active: "Lightbulb",
	retracted: "Trashbin",
	refuted: "Skull",
	superseded: "Restart",
};

/**
 * The plate says whether the claim is in force; the word says why not. Three
 * plates for four statuses would invite the reader to decode a color that
 * carries no more than the label already does.
 *
 * No icon in here: everywhere this renders, it already sits beside another
 * status icon - the row's plate, the detail header's - and a third copy
 * inside the badge would state the same fact a fourth way (plate hue, plate
 * icon, badge icon, badge word) without adding anything a screen reader or
 * a glance needs that the other three do not already carry.
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

/**
 * A bordered grouping. Untitled panels group without adding to the outline.
 *
 * `icon` is decorative - the title text right beside it carries the meaning,
 * and an `<img alt="">` contributes nothing to the heading's accessible name.
 */
export function Panel({
	title,
	icon,
	variant,
	children,
}: {
	title?: string;
	icon?: IconName;
	/**
	 * A colored edge, for the two cases where the border itself is the
	 * message: `notice` for something the reader has to act on, `danger` for
	 * something destructive.
	 *
	 * Not `tone` and not `accent`, both of which already mean something else
	 * in this file. `tone` is which of two constant plate FILLS backs an icon
	 * (`Plate`, `EmptyState`). `accent` is a TEXT color that shifts with the
	 * theme, defined in opposition to a plate - `Button` is tested to fill
	 * "with a plate and never an accent". `variant` follows `Button`, where
	 * `danger` already means exactly this.
	 *
	 * Named for what the border is for rather than what color it is, so the
	 * prop does not become a lie if gold is ever retuned.
	 */
	variant?: "notice" | "danger";
	children: ReactNode;
}) {
	const border =
		variant === "notice"
			? "var(--gold)"
			: variant === "danger"
				? "var(--red)"
				: PALETTE.border;
	return (
		<section
			style={{
				background: "var(--panel)",
				border: `2px solid ${border}`,
				borderRadius: 0,
				padding: "1rem",
			}}
		>
			{title ? (
				<h2
					style={{
						display: "flex",
						alignItems: "center",
						gap: "var(--space-1)",
						margin: "0 0 0.75rem",
						fontFamily: "var(--font-data)",
						fontSize: "var(--text-data-md)",
						letterSpacing: "1px",
						textTransform: "uppercase",
					}}
				>
					{icon ? <Icon name={icon} /> : null}
					{title}
				</h2>
			) : null}
			{children}
		</section>
	);
}

/**
 * The safe ground for an icon: a filled square, teal or red, behind it. A
 * plate's fill is one of exactly two colors and neither shifts with the
 * theme, which is what makes it a reliable ground for an icon whose own
 * dominant color does not - measured - clear 3:1 against `--ground` or
 * `--panel` in every theme. See the design spec's icon-ground rule. Row
 * plates (status, live/revoked) and a plated empty-state illustration are
 * the same shape at different scales, which is why this is one component
 * rather than three copies of the same four facts.
 *
 * `size` names the ICON, not the plate: the plate is `size + 12`px inside
 * its 2px `plateInk` border, so a 16px icon sits inside a 32px box and a
 * 48px icon inside a 64px box - both land on the 4px spacing grid. Nothing
 * in `apps/web` or `packages/brand` sets `box-sizing: border-box`, so that
 * border ADDS to the declared width rather than eating into it - the box a
 * 16px icon renders in is 28px of fill plus a 2px border on each side, 32px
 * total, not the 28px its own inner width alone would suggest.
 */
export function Plate({
	tone,
	icon,
	size = 16,
}: {
	tone: "teal" | "red";
	icon: IconName;
	size?: 16 | 32 | 48;
}) {
	const inner = `${size + 12}px`;
	return (
		<span
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				flex: "none",
				width: inner,
				height: inner,
				background: tone === "teal" ? PALETTE.plateTeal : PALETTE.plateRed,
				border: `2px solid ${PALETTE.plateInk}`,
			}}
		>
			<Icon name={icon} size={size} />
		</span>
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
	icon,
	tone,
	children,
	action,
}: {
	title: string;
	/** Decorative - the title right beside it already says what's empty. */
	icon?: IconName;
	/**
	 * Render `icon` on a `Plate` of this tone instead of bare. Needed
	 * whenever the icon's own dominant color does not clear 3:1 against the
	 * page - see `Plate`'s doc comment and the design spec's icon-ground
	 * rule - which a 48px illustration is large enough to fail on its own.
	 */
	tone?: "teal" | "red";
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
			{icon ? (
				<div style={{ display: "flex", justifyContent: "center" }}>
					{tone ? (
						<Plate tone={tone} icon={icon} size={48} />
					) : (
						<Icon name={icon} size={48} />
					)}
				</div>
			) : null}
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
	describedBy,
}: {
	children: ReactNode;
	onClick: () => void;
	variant?: "primary" | "danger";
	loading?: boolean;
	loadingLabel?: string;
	disabled?: boolean;
	/** Wired to aria-describedby. ConfirmAction uses it to name the question. */
	describedBy?: string;
}) {
	// Pending is announced, not disabled. Setting the `disabled` attribute here
	// - which this did - moves focus to <body> the instant the button the user
	// just pressed goes inert, and it does it in the middle of a destructive
	// round-trip. aria-busy says the same thing to assistive tech, aria-disabled
	// says it to everyone, and the handler guard below is what actually stops a
	// second press. The reason for the original treatment still holds: retract
	// round-trips rather than updating optimistically, so the control is live
	// for as long as the request takes and a second press would transition a
	// lesson already moving. Only the mechanism changed.
	const inert = loading || disabled;
	const plate = variant === "danger" ? PALETTE.plateRed : PALETTE.plateTeal;
	return (
		<button
			type="button"
			aria-busy={loading ? true : undefined}
			aria-disabled={inert || undefined}
			aria-describedby={describedBy}
			onClick={() => {
				if (inert) return;
				onClick();
			}}
			style={{
				padding: "0.5rem 1rem",
				background: inert ? "var(--panel)" : plate,
				color: inert ? "var(--ink)" : PALETTE.plateInk,
				border: inert
					? "2px solid var(--ink-dim)"
					: `2px solid ${PALETTE.plateInk}`,
				boxShadow: inert ? "none" : "4px 4px 0 var(--shadow)",
				borderRadius: 0,
				cursor: inert ? "not-allowed" : "pointer",
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
