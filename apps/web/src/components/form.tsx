import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PasswordStrength } from "../lib/validation";

// Lightweight, dependency-free form primitives shared across the auth pages.
// Styling intentionally mirrors the existing LoginPage inline-style look so the
// pages feel consistent until a design system lands.

const PALETTE = {
	primary: "#007bff",
	danger: "#d93025",
	success: "#188038",
	border: "#ccc",
	borderError: "#d93025",
	muted: "#666",
	track: "#e6e6e6",
} as const;

const STRENGTH_COLORS = [
	"#d93025",
	"#d93025",
	"#f5a623",
	"#f5c518",
	"#7cb342",
	"#188038",
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
			<h1 style={{ marginBottom: subtitle ? "0.25rem" : "1rem" }}>{title}</h1>
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
		margin: "0 auto",
		padding: "2rem",
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
					border: `1px solid ${error ? PALETTE.borderError : PALETTE.border}`,
					borderRadius: "4px",
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
	const bg = variant === "danger" ? PALETTE.danger : PALETTE.primary;
	return (
		<button
			type="submit"
			disabled={isDisabled}
			style={{
				width: "100%",
				padding: "0.75rem",
				backgroundColor: isDisabled ? "#ccc" : bg,
				color: "white",
				border: "none",
				borderRadius: "4px",
				cursor: isDisabled ? "not-allowed" : "pointer",
				fontSize: "1rem",
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
	const color = kind === "error" ? PALETTE.danger : PALETTE.success;
	return (
		<div
			role={kind === "error" ? "alert" : "status"}
			style={{
				color,
				border: `1px solid ${color}`,
				backgroundColor: kind === "error" ? "#fdecea" : "#e6f4ea",
				borderRadius: "4px",
				padding: "0.75rem",
				marginBottom: "1rem",
				fontSize: "0.9rem",
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
				style={{ display: "flex", gap: "4px", marginBottom: "0.25rem" }}
				aria-hidden="true"
			>
				{[0, 1, 2, 3].map((i) => (
					<div
						key={i}
						style={{
							flex: 1,
							height: "4px",
							borderRadius: "2px",
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
		<Link to={to} style={{ color: PALETTE.primary }}>
			{children}
		</Link>
	);
}
