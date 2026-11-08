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

/**
 * One page per marketplace entry, in marketplace order. An entry with no prose
 * throws rather than being skipped: a skipped plugin is how customs went
 * without a page, and nothing said so.
 */
export function joinPlugins(plugins: MarketplacePlugin[]): PluginPage[] {
	return plugins.map((plugin) => {
		const prose = proseBySlug.get(plugin.name);
		if (!prose)
			throw new Error(
				`The marketplace lists ${plugin.name}, and src/data/plugins/ has no page for it.`,
			);
		return { ...prose, ...plugin };
	});
}
