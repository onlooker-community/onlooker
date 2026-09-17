import type { IconName } from "./Icon";

// Exported so the heading test can be driven off this list rather than a
// hand-written copy of it: a route added here is covered without anyone
// remembering to extend the test.
export const SECTIONS = [
	// Basket, not ChestTreasure: the brand doc's mapping named ChestTreasure
	// for the approved pool, but it measures 9% legible against the night
	// panel this renders on. See onlooker-1kr, and the amendment on the
	// 2026-08-11 brand spec.
	{ to: "/lessons", label: "Lessons", icon: "Basket" },
	{ to: "/machines", label: "Machines", icon: "Key" },
	// Book: the log-shaped icon in the brand set, and the one not already
	// spoken for by lessons, machines, settings or profile.
	{ to: "/activity", label: "Activity", icon: "Book" },
	{ to: "/settings", label: "Settings", icon: "Gear" },
	// CatHead is an extension of the brand doc's mapping, not one of its
	// entries - the set has no person icon, and it is the most person-like
	// thing in it. See the doc's Icons section.
	{ to: "/profile", label: "Profile", icon: "CatHead" },
] as const satisfies readonly { to: string; label: string; icon: IconName }[];

/**
 * Which section a path belongs to, or undefined for a path outside the shell.
 *
 * Exact match or a `to`-plus-slash prefix, so /lessons/:id resolves to Lessons.
 * Prefix alone would be wrong in principle - /lessons would also match a future
 * /lessons-archive - and the slash costs nothing.
 *
 * Lives here rather than inside AppShell because titles.ts asks the same
 * question. Two copies of this rule is exactly the drift that onlooker-eqb was
 * filed about, one level down.
 */
export function sectionFor(
	pathname: string,
): (typeof SECTIONS)[number] | undefined {
	return SECTIONS.find(
		(candidate) =>
			pathname === candidate.to || pathname.startsWith(`${candidate.to}/`),
	);
}
