import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { auth } from "../auth";
import { PALETTE } from "./palette";
import SessionExpiryBanner from "./SessionExpiryBanner";

// The chrome around every authenticated route. Until now the only navigation
// in the app was an ad-hoc <nav> inside DashboardPage, so it existed on exactly
// one page and disappears when that page does.
//
// Takes children rather than rendering an <Outlet>, so it works both as a
// layout route and as a direct wrapper. Nothing routes through it yet.

const SECTIONS = [
	{ to: "/lessons", label: "Lessons" },
	{ to: "/machines", label: "Machines" },
	{ to: "/settings", label: "Settings" },
	{ to: "/profile", label: "Profile" },
] as const;

export default function AppShell({ children }: { children: ReactNode }) {
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();

	const handleLogout = async () => {
		await logout();
		navigate("/");
	};

	return (
		<div style={{ minHeight: "100vh", fontFamily: "var(--font-body)" }}>
			<header
				style={{
					display: "flex",
					alignItems: "center",
					gap: "1.5rem",
					flexWrap: "wrap",
					padding: "0.75rem 1.5rem",
					background: "var(--panel)",
					// ink-dim rather than edge: this rule divides the header's
					// --panel fill from the page's --ground, and edge only
					// clears ~1.8-2.7 against panel. Same call TextField makes.
					borderBottom: `2px solid ${PALETTE.border}`,
				}}
			>
				<span
					style={{
						fontFamily: "var(--font-display)",
						fontSize: "16px",
						letterSpacing: "2px",
						textTransform: "uppercase",
					}}
				>
					Onlooker
				</span>

				<nav
					aria-label="Sections"
					style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}
				>
					{SECTIONS.map((section) => (
						// NavLink, not Link: it sets aria-current="page" on the
						// active one, which is the only thing telling a screen
						// reader which of four identical links you are on.
						<NavLink
							key={section.to}
							to={section.to}
							style={({ isActive }) => ({
								// An accent, not a plate - this is ink on the
								// header's ground, and accents are the tokens
								// that shift with the theme to stay readable.
								color: isActive ? PALETTE.accent : PALETTE.muted,
								fontFamily: "var(--font-display)",
								fontSize: "13px",
								letterSpacing: "1px",
								textTransform: "uppercase",
								textDecoration: "none",
								// Underline rather than color alone, so the
								// current section is not signalled only by hue.
								borderBottom: isActive
									? `2px solid ${PALETTE.accent}`
									: "2px solid transparent",
								paddingBottom: "0.15rem",
							})}
						>
							{section.label}
						</NavLink>
					))}
				</nav>

				<div
					style={{
						marginLeft: "auto",
						display: "flex",
						alignItems: "center",
						gap: "0.75rem",
					}}
				>
					{user ? (
						<span style={{ color: PALETTE.muted, fontSize: "0.85rem" }}>
							{user.name || user.email}
						</span>
					) : null}
					{/*
					  Quiet on purpose. ui.tsx's Button is a filled plate, which
					  is right for Retract and Revoke and far too loud for a
					  control that sits on every page and is rarely the thing
					  anyone came to do.
					*/}
					<button
						type="button"
						onClick={handleLogout}
						style={{
							background: "none",
							border: "none",
							padding: 0,
							color: PALETTE.accent,
							cursor: "pointer",
							fontFamily: "var(--font-display)",
							fontSize: "13px",
							letterSpacing: "1px",
							textTransform: "uppercase",
						}}
					>
						Sign out
					</button>
				</div>
			</header>

			<main style={{ maxWidth: "1100px", margin: "0 auto", padding: "1.5rem" }}>
				{/*
				  Moved off DashboardPage, which PR 4 deletes. It warns that a
				  silent token refresh did not work, which is not a fact about
				  any one page.
				*/}
				<SessionExpiryBanner />
				{children}
			</main>
		</div>
	);
}
