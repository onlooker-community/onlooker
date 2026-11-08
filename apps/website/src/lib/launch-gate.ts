/**
 * The paths a reader can open while SITE_LAUNCHED is false. Everything else
 * redirects to the coming-soon page.
 *
 * Named rather than inferred. Astro runs middleware while it prerenders, so
 * prerendering a page does not get it past the gate: the page is built as a
 * redirect document instead (measured 2026-11-07, and what
 * onlooker.dev/plugins/ served at the time).
 */
export function isPublicBeforeLaunch(pathname: string): boolean {
	return (
		pathname === "/" ||
		pathname === "/blog" ||
		pathname.startsWith("/blog/") ||
		pathname === "/plugins" ||
		pathname.startsWith("/plugins/")
	);
}
