import type { MarketplacePlugin } from "../../lib/marketplace";

export type PluginCategory =
	| "substrate"
	| "memory"
	| "analysis"
	| "safety"
	| "testing"
	| "governance"
	| "quality";

/**
 * The part of a plugin page a person writes. Everything that drifts - the
 * version, the description, whether the plugin exists at all - comes from the
 * marketplace (src/lib/marketplace.ts). Keep this short: capabilities lists,
 * config blocks and event tables were the parts that went stale first, and
 * the README linked from every page carries that detail.
 */
export interface PluginProse {
	/** Equals the marketplace entry's `name`. */
	slug: string;
	/** Display name, e.g. "Archivist". */
	name: string;
	tagline: string;
	category: PluginCategory;
	problem: string;
	/** Two to four lines, each true of the plugin's README. */
	howItWorks: string[];
}

export type PluginPage = MarketplacePlugin & PluginProse;
