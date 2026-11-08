import type { MarketplacePlugin } from "../../lib/marketplace";
import { archivist } from "./archivist";
import { assayer } from "./assayer";
import { bursar } from "./bursar";
import { cartographer } from "./cartographer";
import { compass } from "./compass";
import { counsel } from "./counsel";
import { curator } from "./curator";
import { customs } from "./customs";
import { echo } from "./echo";
import { ecosystem } from "./ecosystem";
import { governor } from "./governor";
import { historian } from "./historian";
import { inspector } from "./inspector";
import { librarian } from "./librarian";
import { lineage } from "./lineage";
import { scribe } from "./scribe";
import { tribunal } from "./tribunal";
import type { PluginPage, PluginProse } from "./types";
import { warden } from "./warden";

export type { PluginCategory, PluginPage, PluginProse } from "./types";

export const allProse: PluginProse[] = [
	ecosystem,
	archivist,
	assayer,
	bursar,
	cartographer,
	compass,
	counsel,
	curator,
	customs,
	echo,
	governor,
	historian,
	inspector,
	librarian,
	lineage,
	scribe,
	tribunal,
	warden,
];

const proseBySlug = new Map(allProse.map((p) => [p.slug, p]));

interface JoinOptions {
	/** MARKETPLACE_REQUIRED: on only in the production website build. */
	required: boolean;
	warn?: (message: string) => void;
}

/**
 * One page per marketplace entry, in marketplace order. A skipped plugin is how
 * customs went without a page and nothing said so, so an entry with no prose
 * is never dropped quietly. In the strict production build it throws, naming
 * the plugin, so onlooker.dev cannot ship without it. Everywhere else it warns
 * once, naming the plugin, and leaves it off: an ecosystem release must not
 * turn onlooker's PR CI red before anyone has had the chance to write prose.
 */
export function joinPlugins(
	plugins: MarketplacePlugin[],
	{ required, warn = (message) => console.warn(message) }: JoinOptions,
): PluginPage[] {
	return plugins.flatMap((plugin) => {
		const prose = proseBySlug.get(plugin.name);
		if (prose) return [{ ...prose, ...plugin }];
		const missing = `The marketplace lists ${plugin.name}, and src/data/plugins/ has no page for it.`;
		if (required) throw new Error(missing);
		warn(`[marketplace] ${missing} Leaving it off the site.`);
		return [];
	});
}
