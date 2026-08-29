import type { IconName } from "@onlooker/brand";

/**
 * A brand icon, at one of the three sizes it is legal to render.
 *
 * The sources are 16x16 and only integer multiples render cleanly - anything
 * between turns the art to mush - so `size` is a union of exactly those three
 * rather than a number. `packages/brand/assets.css` supplies `.pixel-icon` and
 * the size classes, including a `flex: none` that must not be removed: in a
 * column flex container a wrapping caption silently squashes the icon.
 *
 * The brand doc says each app wraps the shared assets in its own thin
 * component, because the asset pipeline differs per framework. This is
 * apps/web's.
 */

// A relative glob rather than a bare specifier: Vite's import.meta.glob does
// not accept package names, only paths it can walk at build time. The path is
// stable because the monorepo layout is, and the test asserts it resolved.
const URLS = import.meta.glob<string>(
	"../../../../packages/brand/icons/*.png",
	{ eager: true, query: "?url", import: "default" },
);

function urlFor(name: IconName): string {
	const match = Object.entries(URLS).find(([path]) =>
		path.endsWith(`/${name}.png`),
	);
	return match ? match[1] : "";
}

export function Icon({
	name,
	size = 16,
	label,
}: {
	name: IconName;
	size?: 16 | 32 | 48;
	/**
	 * Only pass this when the icon is the sole carrier of its meaning. Beside a
	 * visible label it is decoration, and announcing both reads the same thing
	 * twice.
	 */
	label?: string;
}) {
	return (
		<img
			src={urlFor(name)}
			className={`pixel-icon pixel-icon--${size}`}
			width={size}
			height={size}
			alt={label ?? ""}
			role={label ? undefined : "presentation"}
		/>
	);
}
