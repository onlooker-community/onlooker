import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { sectionFor } from "./components/sections";

const PRODUCT = "Onlooker";

/**
 * Routes outside the shell that still deserve a name.
 *
 * SECTIONS already names the five shell routes; this is everything else a
 * person can land on. Matched by prefix, because /reset-password and
 * /verify-email carry a token.
 *
 * NOT the place for a parameterized-route list in general: PARAMETERIZED_ROUTES
 * in monitoring.provider.ts does that job for transaction naming and cannot be
 * imported here - it lives in the lazily loaded provider chunk, and an import
 * would pull 50.95 kB back into the main bundle without failing anything.
 */
const TITLES: readonly (readonly [string, string])[] = [
	["/login", "Sign in"],
	["/signup", "Create account"],
	["/forgot-password", "Reset your password"],
	["/reset-password", "Choose a new password"],
	["/verify-email", "Verify your email"],
] as const;

const NOT_FOUND = "Page not found";

/**
 * The document title for a path.
 *
 * Section first, product second: a tab strip truncates from the right, so the
 * specific half is the half that survives.
 *
 * The fallback is the not-found title rather than the bare product name,
 * because a path matching neither list renders the catch-all route and IS the
 * not-found page - "/" excepted, handled below, because it renders
 * RootRedirect rather than the catch-all. The 404 cannot set this itself -
 * React runs child effects before parent ones, so the hook below would
 * overwrite whatever it set. What keeps this from mislabeling a real route
 * nobody listed is the source guard, not this function.
 */
export function titleFor(pathname: string): string {
	// "/" is unmatched the same way an unlisted path is, but it is not one: it
	// is RootRedirect's own route, and RootRedirect renders a bare <Loading>
	// - not <Navigate> - for the whole session-restore window, so the location
	// stays "/" for that entire window rather than moving on immediately. The
	// not-found fallback below would tell the tab, and a screen reader on
	// navigation, that "/" is a route that does not exist - the exact claim
	// NotFoundPage itself refuses to make while a session is still resolving
	// (see not-found.test.tsx). This is the one path that gets a name without
	// appearing in SECTIONS or TITLES.
	if (pathname === "/") return PRODUCT;

	const section = sectionFor(pathname);
	if (section) return `${section.label} · ${PRODUCT}`;

	for (const [prefix, title] of TITLES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
			return `${title} · ${PRODUCT}`;
		}
	}

	return `${NOT_FOUND} · ${PRODUCT}`;
}

/**
 * Keep document.title in step with the route.
 *
 * Mounted once in App rather than called by each page, for the same reason
 * AppShell renders every h1 from SECTIONS: a per-route, boring property that
 * each page has to remember is a property some page will forget. See
 * onlooker-eqb.
 */
export function useDocumentTitle(): void {
	const { pathname } = useLocation();

	useEffect(() => {
		document.title = titleFor(pathname);
	}, [pathname]);
}
