export { archivist } from "./archivist";
export { assayer } from "./assayer";
export { bursar } from "./bursar";
export { cartographer } from "./cartographer";
export { compass } from "./compass";
export { counsel } from "./counsel";
export { curator } from "./curator";
export { echo } from "./echo";
export { governor } from "./governor";
export { historian } from "./historian";
export { inspector } from "./inspector";
export { librarian } from "./librarian";
export { lineage } from "./lineage";
export { scribe } from "./scribe";
export { tribunal } from "./tribunal";
export type {
	PluginCategory,
	PluginData,
	PluginEvent,
	PluginTable,
} from "./types";
export { warden } from "./warden";

import { archivist } from "./archivist";
import { assayer } from "./assayer";
import { bursar } from "./bursar";
import { cartographer } from "./cartographer";
import { compass } from "./compass";
import { counsel } from "./counsel";
import { curator } from "./curator";
import { echo } from "./echo";
import { governor } from "./governor";
import { historian } from "./historian";
import { inspector } from "./inspector";
import { librarian } from "./librarian";
import { lineage } from "./lineage";
import { scribe } from "./scribe";
import { tribunal } from "./tribunal";
import type { PluginData } from "./types";
import { warden } from "./warden";

export const allPlugins: PluginData[] = [
	archivist,
	assayer,
	bursar,
	cartographer,
	compass,
	counsel,
	curator,
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

export const pluginsBySlug = Object.fromEntries(
	allPlugins.map((p) => [p.slug, p]),
);
