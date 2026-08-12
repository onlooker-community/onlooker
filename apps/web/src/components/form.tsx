import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PasswordStrength } from "../lib/validation";

// Lightweight, dependency-free form primitives shared across the auth pages.
// Styling intentionally mirrors the existing LoginPage inline-style look so the
// pages feel consistent until a design system lands.

// Values are CSS custom properties from @onlooker/brand, resolved at render
// time - React inline styles pass var() through untouched. Plates are constant
// across themes; the text accents shift. See the brand spec.
const PALETTE = {
	// A plate is a filled background and is constant across themes; an accent
	// is ink on a ground and shifts. One key cannot be both - using the plate
	// as text put links at 1.35 contrast in day mode.
	plateTeal: "var(--plate-teal)",
	plateRed: "var(--plate-red)",
	plateInk: "var(--plate-ink)",
	accent: "var(--teal)",
	danger: "var(--red)",
	success: "var(--teal)",
	border: "var(--edge)",
	borderError: "var(--red)",
	muted: "var(--ink-dim)",
	track: "var(--panel)",
} as const;

// The meter ramps from failing to strong. It reuses the semantic tokens rather
// than a private scale so it tracks the theme like everything else.
//
// These are accents, not plates, and that's deliberate: a bar segment is a
// bare graphical fill with no text on it, so it only needs to contrast the
// surface it sits on (WCAG 1.4.11), not carry a fixed label ink (1.4.3) - but
// this same computed color is also used as literal text color for the
// Weak/Fair/Good/Strong label below, so pointing the bar at a plate would
// move the label too. That surface differs by page: inside AuthCard (signup,
// reset-password) it's the card's own --panel plate; on the settings page,
// which has no AuthCard wrapper, it's --ground. A plate would go
// near-invisible against panel in day mode; the accent shifting with the
// theme is what keeps it visible against either.
const STRENGTH_COLORS = [
	"var(--red)",
	"var(--red)",
	"var(--gold)",
	"var(--gold)",
	"var(--teal)",
	"var(--teal)",
] as const;

export function AuthCard({
	title,
	subtitle,
	onSubmit,
	children,
	footer,
}: {
	title: string;
	subtitle?: ReactNode;
	onSubmit?: (e: React.FormEvent) => void;
	children: ReactNode;
	footer?: ReactNode;
}) {
	const inner = (
		<>
			<h1
				style={{
					marginBottom: subtitle ? "0.25rem" : "1rem",
					fontFamily: "var(--font-display)",
					color: "var(--ink-hi)",
					fontSize: "24px",
					letterSpacing: "0.5px",
				}}
			>
				{title}
			</h1>
			{subtitle && (
				<p
					style={{ color: PALETTE.muted, marginTop: 0, marginBottom: "1.5rem" }}
				>
					{subtitle}
				</p>
			)}
			{children}
			{footer && (
				<div style={{ marginTop: "1.5rem", fontSize: "0.9rem" }}>{footer}</div>
			)}
		</>
	);

	const style: CSSProperties = {
		maxWidth: "420px",
		margin: "4rem auto",
		padding: "2rem",
		background: "var(--panel)",
		border: "2px solid var(--edge)",
		// Hard offset, no blur - the 16-bit look has no soft shadows.
		boxShadow: "6px 6px 0 var(--shadow)",
	};

	return onSubmit ? (
		<form onSubmit={onSubmit} noValidate style={style}>
			{inner}
		</form>
	) : (
		<div style={style}>{inner}</div>
	);
}

export function TextField({
	id,
	label,
	type = "text",
	value,
	onChange,
	error,
	disabled,
	autoComplete,
	required,
	placeholder,
	hint,
}: {
	id: string;
	label: string;
	type?: string;
	value: string;
	onChange: (value: string) => void;
	error?: string | null;
	disabled?: boolean;
	autoComplete?: string;
	required?: boolean;
	placeholder?: string;
	hint?: ReactNode;
}) {
	const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
		.filter(Boolean)
		.join(" ");

	return (
		<div style={{ marginBottom: "1rem" }}>
			<label htmlFor={id} style={{ display: "block", marginBottom: "0.25rem" }}>
				{label}
			</label>
			<input
				id={id}
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled}
				required={required}
				placeholder={placeholder}
				autoComplete={autoComplete}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy || undefined}
				style={{
					width: "100%",
					padding: "0.5rem",
					boxSizing: "border-box",
					background: "var(--ground)",
					color: "var(--ink)",
					border: `2px solid ${error ? PALETTE.borderError : PALETTE.border}`,
					borderRadius: 0,
					fontFamily: "var(--font-body)",
				}}
			/>
			{hint && (
				<div
					id={`${id}-hint`}
					style={{
						color: PALETTE.muted,
						fontSize: "0.8rem",
						marginTop: "0.25rem",
					}}
				>
					{hint}
				</div>
			)}
			{error && (
				<div
					id={`${id}-error`}
					role="alert"
					style={{
						color: PALETTE.danger,
						fontSize: "0.85rem",
						marginTop: "0.25rem",
					}}
				>
					{error}
				</div>
			)}
		</div>
	);
}

export function SubmitButton({
	loading,
	loadingLabel,
	children,
	disabled,
	variant = "primary",
}: {
	loading?: boolean;
	loadingLabel?: string;
	children: ReactNode;
	disabled?: boolean;
	variant?: "primary" | "danger";
}) {
	const isDisabled = loading || disabled;
	// Both variants are filled buttons, so both need a plate, not an accent -
	// var(--red) shifts per theme, and no constant label color reads on a
	// background that moves under it. plate-ink on either plate holds at
	// ~7-8.3 contrast in both themes; no conditional needed.
	const plate = variant === "danger" ? PALETTE.plateRed : PALETTE.plateTeal;
	return (
		<button
			type="submit"
			disabled={isDisabled}
			style={{
				width: "100%",
				padding: "0.75rem",
				// Plates are constant across themes, so plate-ink holds at 8.32
				// on teal and 7.00 on red in both. Disabled recedes into the
				// card and keeps its edge; the old white-on-#ccc was 1.61.
				background: isDisabled ? "var(--panel)" : plate,
				color: isDisabled ? "var(--ink)" : PALETTE.plateInk,
				// var(--edge) as a border reads fine on the ground the card
				// sits on, but the button's border sits on the card's own
				// panel fill - edge is only ~1.8-2.7 against that. Disabled
				// swaps to ink-dim, which clears the 3:1 non-text threshold
				// against panel in both themes. Enabled swaps to plate-ink,
				// which is flat against the day-mode panel too (day plates
				// are ~1.0-1.5 against panel) - plate-ink carries the edge
				// from inside instead, at 7.00-8.32 against its own plate.
				border: isDisabled
					? "2px solid var(--ink-dim)"
					: `2px solid ${PALETTE.plateInk}`,
				boxShadow: isDisabled ? "none" : "4px 4px 0 var(--shadow)",
				borderRadius: 0,
				cursor: isDisabled ? "not-allowed" : "pointer",
				fontFamily: "var(--font-display)",
				fontSize: "14px",
				letterSpacing: "1px",
				textTransform: "uppercase",
			}}
		>
			{loading ? (loadingLabel ?? "Working...") : children}
		</button>
	);
}

export function FormMessage({
	kind,
	children,
}: {
	kind: "error" | "success";
	children: ReactNode;
}) {
	const plate = kind === "error" ? PALETTE.plateRed : PALETTE.plateTeal;
	return (
		<div
			role={kind === "error" ? "alert" : "status"}
			style={{
				background: plate,
				color: PALETTE.plateInk,
				// See SubmitButton: edge is flat against a day-mode plate,
				// so plate-ink carries the border from inside instead.
				border: `2px solid ${PALETTE.plateInk}`,
				borderRadius: 0,
				padding: "0.75rem",
				marginBottom: "1rem",
				fontSize: "0.9rem",
				fontFamily: "var(--font-body)",
			}}
		>
			{children}
		</div>
	);
}

export function PasswordStrengthMeter({
	strength,
	password,
}: {
	strength: PasswordStrength;
	password: string;
}) {
	if (!password) return null;

	const filled = strength.score;
	const color =
		STRENGTH_COLORS[Math.min(strength.score + 1, STRENGTH_COLORS.length - 1)];

	return (
		<div style={{ marginTop: "-0.5rem", marginBottom: "1rem" }}>
			<div
				style={{
					display: "flex",
					gap: "4px",
					marginBottom: "0.25rem",
					// The unfilled track is PALETTE.track, which is --panel -
					// the same fill AuthCard uses, so unfilled segments are
					// invisible against the card (1.00). An outline bounds
					// the meter's full extent so "2 of 4" still reads as
					// two filled slots inside four, not two filled slots
					// alone. ink-dim clears 3:1 against panel in both
					// themes; it can't be the segment fill itself, since
					// it's near 1:1 against the filled accent colors too.
					border: "2px solid var(--ink-dim)",
				}}
				aria-hidden="true"
			>
				{[0, 1, 2, 3].map((i) => (
					<div
						key={i}
						style={{
							flex: 1,
							height: "6px",
							borderRadius: 0,
							backgroundColor: i < filled ? color : PALETTE.track,
							transition: "background-color 150ms ease",
						}}
					/>
				))}
			</div>
			<div
				aria-live="polite"
				style={{ fontSize: "0.8rem", color: PALETTE.muted }}
			>
				Strength: <strong style={{ color }}>{strength.label}</strong>
				{strength.suggestions.length > 0 && (
					<span> — {strength.suggestions[0]}</span>
				)}
			</div>
		</div>
	);
}

export function FormLink({
	to,
	children,
}: {
	to: string;
	children: ReactNode;
}) {
	return (
		<Link to={to} style={{ color: PALETTE.accent }}>
			{children}
		</Link>
	);
}
