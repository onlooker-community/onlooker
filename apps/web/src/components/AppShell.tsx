import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { auth } from "../auth";
import { useReveal } from "../reveal";
import { Icon } from "./Icon";
import { PALETTE } from "./palette";
import SessionExpiryBanner from "./SessionExpiryBanner";

declare module "react" {
	interface HTMLAttributes<T> {
		// React 18 has no typing for `inert`; React 19 adds it. Declared here
		// rather than cast at the use site so there is one place to delete when
		// this workspace moves to 19.
		inert?: "";
	}
}

// The chrome around every authenticated route. Before this, the only
// navigation in the app was an ad-hoc <nav> inside DashboardPage, which
// existed on exactly one page and disappeared with it in onlooker-yfw.
//
// Takes children rather than rendering an <Outlet>, so it works both as a
// layout route and as a direct wrapper. Every authenticated route goes
// through it now: /lessons as the layout route, whose :id child renders
// through LessonsPage's own Outlet, and /machines, /settings and /profile
// as direct wrappers.

const SECTIONS = [
	// ChestTreasure: the approved pool, in the brand doc's own mapping.
	{ to: "/lessons", label: "Lessons", icon: "ChestTreasure" },
	{ to: "/machines", label: "Machines", icon: "Key" },
	// Book: the log-shaped icon in the brand set, and the one not already
	// spoken for by lessons, machines, settings or profile.
	{ to: "/activity", label: "Activity", icon: "Book" },
	{ to: "/settings", label: "Settings", icon: "Gear" },
	// CatHead is an extension of the brand doc's mapping, not one of its
	// entries - the set has no person icon, and it is the most person-like
	// thing in it. See the doc's Icons section.
	{ to: "/profile", label: "Profile", icon: "CatHead" },
] as const;

export default function AppShell({ children }: { children: ReactNode }) {
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();
	const { revealed, dismiss } = useReveal();

	const handleLogout = async () => {
		// Explicitly, and before the logout lands. The provider deliberately
		// watches no auth state - it cannot tell a sign-out from a session
		// expiry, and only this one may take a live credential off the screen.
		//
		// `inert` below puts this button out of reach while a reveal is open,
		// so on a browser that implements inert this is defense in depth. On
		// one that does not - it ignores the attribute rather than failing -
		// the button is live and this is the only thing that clears the token.
		dismiss();
		await logout();
		navigate("/");
	};

	return (
		<div
			// Written as a string, not a boolean. React 18.3.1 renders `inert=""`
			// and silently drops `inert={true}` - so `inert={Boolean(revealed)}`
			// would leave this looking correct and doing nothing. Measured, not
			// assumed.
			inert={revealed ? "" : undefined}
			style={{ minHeight: "100vh", fontFamily: "var(--font-body)" }}
		>
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
						display: "flex",
						alignItems: "center",
						gap: "var(--space-1)",
						fontFamily: "var(--font-display)",
						fontSize: "var(--text-display-md)",
						letterSpacing: "2px",
						textTransform: "uppercase",
					}}
				>
					{/* Eye: the logo and the active state, in the brand doc's own mapping. */}
					<Icon name="Eye" />
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
								display: "inline-flex",
								alignItems: "center",
								gap: "var(--space-1)",
								// An accent, not a plate - this is ink on the
								// header's ground, and accents are the tokens
								// that shift with the theme to stay readable.
								color: isActive ? PALETTE.accent : PALETTE.muted,
								fontFamily: "var(--font-data)",
								fontSize: "var(--text-data-md)",
								letterSpacing: "1px",
								textTransform: "uppercase",
								textDecoration: "none",
								// Underline rather than color alone, so the
								// current section is not signaled only by hue.
								borderBottom: isActive
									? `2px solid ${PALETTE.accent}`
									: "2px solid transparent",
								paddingBottom: "0.15rem",
							})}
						>
							{/* Decorative: the visible label right beside it carries
							    the meaning, same as StatusBadge's icon. */}
							<Icon name={section.icon} />
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
							fontFamily: "var(--font-data)",
							fontSize: "var(--text-data-md)",
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
				  Moved off DashboardPage before onlooker-yfw deleted it. It warns
				  that a silent token refresh did not work, which is not a fact
				  about any one page.
				*/}
				<SessionExpiryBanner />
				{children}
			</main>
			{/*
			  A license condition, not a courtesy. CC BY 4.0 requires credit
			  wherever the icons ship, and the brand doc is explicit that a line
			  in a README nobody renders does not satisfy it. On the shell rather
			  than an /about route so it is present on every page the icons are.
			*/}
			<footer
				style={{
					maxWidth: "1100px",
					margin: "0 auto",
					padding: "var(--space-5) var(--space-5) var(--space-6)",
					color: PALETTE.muted,
					fontSize: "var(--text-body-sm)",
					borderTop: `2px solid ${PALETTE.border}`,
				}}
			>
				Icons by{" "}
				<a
					href="https://crusenho.itch.io"
					style={{ color: PALETTE.accent }}
					target="_blank"
					rel="noreferrer"
				>
					Crusenho Agus Hennihuno
				</a>
				, licensed{" "}
				<a
					href="https://creativecommons.org/licenses/by/4.0/"
					style={{ color: PALETTE.accent }}
					target="_blank"
					rel="noreferrer"
				>
					CC BY 4.0
				</a>
				.
			</footer>
		</div>
	);
}
