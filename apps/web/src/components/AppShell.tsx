import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { auth } from "../auth";
import { useReveal } from "../reveal";
import "./app-shell.css";
import { Icon } from "./Icon";
import { PALETTE } from "./palette";
import SessionExpiryBanner from "./SessionExpiryBanner";
import { ACCOUNT_SECTION_PATHS, SECTIONS, sectionFor } from "./sections";

// Re-exported because shell-headings.test.tsx drives its cases off
// `SECTIONS` imported from here. The list itself lives in ./sections so the
// path matcher beside it can be tested without mounting React.
export { SECTIONS };

// What the product does, and who you are. Derived from SECTIONS rather than
// stored as two lists, so adding a section still means editing one place and
// the heading lookup keeps seeing every one of them. See ONL-178.
const ACCOUNT_SECTIONS = SECTIONS.filter((s) =>
	ACCOUNT_SECTION_PATHS.includes(s.to),
);
const PRODUCT_SECTIONS = SECTIONS.filter(
	(s) => !ACCOUNT_SECTION_PATHS.includes(s.to),
);

/**
 * A nav link, in the bar and in the expanded menu alike.
 *
 * One function rather than two copies: the two layouts differ in where the
 * links sit, never in what a link looks like, and a second copy is how the
 * active treatment ends up applied in one place and not the other.
 */
const sectionLink = ({ isActive }: { isActive: boolean }) => ({
	display: "inline-flex",
	alignItems: "center",
	gap: "var(--space-1)",
	// An accent, not a plate - this is ink on the header's ground, and
	// accents are the tokens that shift with the theme to stay readable.
	color: isActive ? PALETTE.accent : PALETTE.muted,
	fontFamily: "var(--font-data)",
	fontSize: "var(--text-data-md)",
	// Weight as well as color, so the current section is not signaled only
	// by hue. It was an underline until ONL-218: in the stacked menus an
	// underlined link just above a divider read as two rules. The data face
	// is monospaced, so bold takes the same width and the bar does not shift
	// when the section changes.
	fontWeight: isActive ? 700 : 400,
	letterSpacing: "1px",
	textTransform: "uppercase" as const,
	textDecoration: "none",
	whiteSpace: "nowrap" as const,
});

/**
 * Sign out, in both layouts.
 *
 * Quiet on purpose. ui.tsx's Button is a filled plate, which is right for
 * Retract and Revoke and far too loud for a control that sits on every page
 * and is rarely the thing anyone came to do.
 */
const quietControl = {
	background: "none",
	border: "none",
	padding: 0,
	color: PALETTE.accent,
	cursor: "pointer",
	fontFamily: "var(--font-data)",
	fontSize: "var(--text-data-md)",
	letterSpacing: "1px",
	textTransform: "uppercase" as const,
};

// The chrome around every authenticated route. Before this, the only
// navigation in the app was an ad-hoc <nav> inside DashboardPage, which
// existed on exactly one page and disappeared with it in onlooker-yfw.
//
// Takes children rather than rendering an <Outlet>, so it works both as a
// layout route and as a direct wrapper. Every authenticated route goes
// through it now: /lessons as the layout route, whose :id child renders
// through LessonsPage's own Outlet, and /machines, /settings and /profile
// as direct wrappers.

export default function AppShell({ children }: { children: ReactNode }) {
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const { dismiss } = useReveal();
	const [expanded, setExpanded] = useState(false);
	const toggleRef = useRef<HTMLButtonElement>(null);
	// The account dropdown above the breakpoint, ONL-218. Its own state rather
	// than a second use of `expanded`: the two controls never show at the same
	// width, but each owns its panel and its focus return.
	const [accountOpen, setAccountOpen] = useState(false);
	const accountButtonRef = useRef<HTMLButtonElement>(null);
	const accountRef = useRef<HTMLDivElement>(null);

	// Close on navigation, or the menu stays open over the page it just
	// opened. The panel only exists below the breakpoint, where it covers the
	// content, so leaving it up means tapping a section and seeing the menu
	// again rather than the thing you asked for.
	//
	// Keyed on pathname rather than on the click, so a section reached any
	// other way - a link in the page, the back button - closes it too. The
	// pathname is the whole dependency: `expanded` is what this sets, and
	// depending on it would re-run the effect on every open.
	useEffect(() => {
		setExpanded(false);
		setAccountOpen(false);
	}, [location.pathname]);

	// Escape closes it and focus goes back to the control that opened it.
	// Without the second half, closing leaves focus on a button that no longer
	// exists in the accessibility tree and the next Tab starts from the top of
	// the document.
	//
	// The reference this header follows does neither - it sets aria-expanded
	// and leaves the rest to an animation library. This is the chrome around
	// every authenticated route, so it is worth more than that.
	useEffect(() => {
		if (!expanded) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setExpanded(false);
			toggleRef.current?.focus();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [expanded]);

	// The account dropdown closes the same ways, and on a press anywhere
	// outside it too. It opens over the page rather than pushing the page
	// down the way the narrow menu does, so leaving it up would cover whatever
	// the person turned back to. mousedown rather than click, so it is gone
	// before the press lands on whatever was under it.
	useEffect(() => {
		if (!accountOpen) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setAccountOpen(false);
			accountButtonRef.current?.focus();
		};
		const onPress = (event: MouseEvent) => {
			if (accountRef.current?.contains(event.target as Node)) return;
			setAccountOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPress);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPress);
		};
	}, [accountOpen]);

	// The page heading comes from SECTIONS rather than from the page, which is
	// the whole of the fix for onlooker-eqb. Two of the five shell routes named
	// themselves nowhere in the heading outline - /activity's first heading was
	// a date - and /settings disagreed with its own nav label, announcing
	// "Settings, current page" above a heading reading "Account settings".
	// Rendering the label from the one place it is defined means the pages
	// cannot drift, and a sixth route gets a heading by existing rather than by
	// someone remembering.
	//
	// Exact match or a `to`-plus-slash prefix, so /lessons/:id resolves to
	// Lessons. Prefix alone would be wrong in principle - /lessons would also
	// match a future /lessons-archive - and the slash costs nothing.
	//
	// A shell route with no SECTIONS entry renders no h1. Every shell route
	// today is a nav destination; one deliberately absent from the nav would be
	// a larger question than this. See the design's Section 2.
	const section = sectionFor(location.pathname);

	const handleLogout = async () => {
		// Explicitly, and before the logout lands. The provider deliberately
		// watches no auth state - it cannot tell a sign-out from a session
		// expiry, and only this one may take a live credential off the screen.
		//
		// `InertWhileRevealed`, which wraps every route in App.tsx, puts this
		// button out of reach while a reveal is open - so on a browser that
		// implements inert this is defense in depth. On one that does not - it
		// ignores the attribute rather than failing - the button is live and
		// this is the only thing that clears the token.
		dismiss();
		await logout();
		navigate("/");
	};

	return (
		<div style={{ minHeight: "100vh", fontFamily: "var(--font-body)" }}>
			<header
				style={{
					padding: "0.75rem 0",
					background: "var(--panel)",
					// ink-dim rather than edge: this rule divides the header's
					// --panel fill from the page's --ground, and edge only
					// clears ~1.8-2.7 against panel. Same call TextField makes.
					borderBottom: `2px solid ${PALETTE.border}`,
				}}
			>
				<div className="app-header-inner">
					{/*
					 * The bar, and every element in it that app-shell.css addresses
					 * carries NO inline layout - see that file's header for why. The
					 * styles that remain here are color and type, which do not vary
					 * with width.
					 */}
					<nav className="app-nav-bar" aria-label="Sections">
						{/*
						 * First and a link home, ONL-218. Centered between the groups
						 * it read as an eighth section that did nothing when clicked.
						 * A plain Link rather than a NavLink: it is never the current
						 * section. Bold display face at twice the pixel scale, in
						 * --ink-hi, where every section link is small --ink-dim data
						 * type. At display-md and regular weight it still passed for
						 * a link.
						 */}
						<Link
							to="/"
							className="app-wordmark"
							style={{
								color: "var(--ink-hi)",
								fontFamily: "var(--font-display)",
								fontSize: "var(--text-display-lg)",
								fontWeight: 700,
								letterSpacing: "2px",
								textTransform: "uppercase",
								textDecoration: "none",
							}}
						>
							{/* Eye: the logo and the active state, in the brand doc's own mapping. */}
							<Icon name="Eye" size={32} />
							Onlooker
						</Link>

						<div className="app-nav-group">
							{PRODUCT_SECTIONS.map((section) => (
								<NavLink key={section.to} to={section.to} style={sectionLink}>
									{/* Decorative: the visible label right beside it carries
									    the meaning, same as StatusBadge's icon. */}
									<Icon name={section.icon} />
									{section.label}
								</NavLink>
							))}
						</div>

						{/*
						 * Who you are, as one control, ONL-218. Seven links, a name and
						 * Sign out did not fit beside the wordmark in 1100px, and the
						 * account side is the part nobody visits on every page.
						 *
						 * A disclosure rather than role="menu": these are links and a
						 * button, reached with Tab like every other link here. The menu
						 * role would promise arrow-key navigation this does not do.
						 * Rendered only while open, for the reason the narrow panel
						 * gives below.
						 */}
						<div
							ref={accountRef}
							className="app-nav-group app-nav-group--account"
						>
							<button
								ref={accountButtonRef}
								type="button"
								className="app-account-toggle"
								aria-expanded={accountOpen}
								aria-controls="app-account-menu"
								onClick={() => setAccountOpen((open) => !open)}
							>
								{user ? user.name || user.email : "Account"}
								{/* Text rather than an icon, for the reason the Menu
								    toggle gives: the brand set has no chevron. */}
								<span aria-hidden="true">{accountOpen ? "▴" : "▾"}</span>
							</button>
							{accountOpen ? (
								<div id="app-account-menu" className="app-account-menu">
									{ACCOUNT_SECTIONS.map((section) => (
										<NavLink
											key={section.to}
											to={section.to}
											style={sectionLink}
										>
											<Icon name={section.icon} />
											{section.label}
										</NavLink>
									))}
									<hr className="app-menu-rule" />
									<button
										type="button"
										onClick={handleLogout}
										style={{ ...quietControl, justifySelf: "start" }}
									>
										Sign out
									</button>
								</div>
							) : null}
						</div>

						{/*
						 * Text rather than a glyph. The brand's icon set holds no
						 * hamburger and no close, and UNPLATED_ICONS in packages/brand
						 * is an enforcement surface - an unplated icon has to be listed
						 * there and clear a contrast floor on all four theme grounds,
						 * which 19 of the set cannot. The Sign out button beside this
						 * one is already a text-only control in exactly this style.
						 */}
						<button
							ref={toggleRef}
							type="button"
							className="app-nav-toggle"
							aria-expanded={expanded}
							aria-controls="app-menu"
							onClick={() => setExpanded((open) => !open)}
						>
							{expanded ? "Close" : "Menu"}
						</button>
					</nav>

					{/*
					 * Rendered only while open rather than hidden with CSS. Hiding it
					 * would leave a second copy of every link in the document at all
					 * times - in the accessibility tree, and in the getByRole queries
					 * the shell tests already make, where it would turn every
					 * single-match query into an ambiguous one.
					 *
					 * Its own label: two navs are in the document while this is open,
					 * and two landmarks sharing a name is worse than either name.
					 */}
					{expanded ? (
						<nav id="app-menu" className="app-menu" aria-label="All sections">
							<div style={{ display: "grid", gap: "var(--space-4)" }}>
								{PRODUCT_SECTIONS.map((section) => (
									<NavLink key={section.to} to={section.to} style={sectionLink}>
										<Icon name={section.icon} />
										{section.label}
									</NavLink>
								))}
							</div>

							<hr className="app-menu-rule" />

							{/*
							 * The same order as the dropdown above the breakpoint: who
							 * you are, then the account sections, then Sign out on its
							 * own. The name used to sit between Profile and Sign out,
							 * where it read as one more item rather than the label for
							 * the group.
							 */}
							<div style={{ display: "grid", gap: "var(--space-4)" }}>
								{user ? (
									<span className="app-menu-user">
										{user.name || user.email}
									</span>
								) : null}
								{ACCOUNT_SECTIONS.map((section) => (
									<NavLink key={section.to} to={section.to} style={sectionLink}>
										<Icon name={section.icon} />
										{section.label}
									</NavLink>
								))}
							</div>

							<hr className="app-menu-rule" />

							<div style={{ display: "grid", gap: "var(--space-4)" }}>
								<button
									type="button"
									onClick={handleLogout}
									style={{ ...quietControl, justifySelf: "start" }}
								>
									Sign out
								</button>
							</div>
						</nav>
					) : null}
				</div>
			</header>

			<main style={{ maxWidth: "1100px", margin: "0 auto", padding: "1.5rem" }}>
				{/*
				  Moved off DashboardPage before onlooker-yfw deleted it. It warns
				  that a silent token refresh did not work, which is not a fact
				  about any one page.
				*/}
				<SessionExpiryBanner />
				{/*
				  After the banner deliberately. The banner warns that a silent
				  token refresh did not work, which is session chrome rather
				  than page content - someone who needs it should not have to
				  pass the page title to reach it.
				*/}
				{section ? (
					<h1
						style={{
							margin: "0 0 var(--space-3)",
							// The readable face, not the pixel one, matching the
							// page heading LessonDetail already established: a
							// heading here leads by size and weight rather than
							// by face.
							fontFamily: "var(--font-body)",
							fontSize: "var(--text-body-lg)",
						}}
					>
						{section.label}
					</h1>
				) : null}
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
