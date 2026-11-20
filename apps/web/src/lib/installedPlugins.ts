/**
 * Which Onlooker plugins are installed, and which of them were silent, for
 * the home page's Plugins panel (ONL-298).
 *
 * Imported from the schema's `event-roles` subpath, never its root: the root
 * re-exports the validator, which loads node:fs and cannot run in a browser.
 */

import { EVENT_TYPE_ROLES } from "@onlooker-community/schema/event-roles";
import type { Inventory, Machine } from "../api/machinesApi";
import type { SessionSummary } from "../api/sessionsApi";
import { pluginOf } from "./pluginActivity";

/** Plugins from any other marketplace never emit Onlooker events. */
const ONLOOKER_MARKETPLACE = "onlooker-community";

/**
 * Plugins the schema names an event of their own for. A plugin outside this
 * set, like ecosystem, never emits under its own name, so "no events this
 * week" would be true of it every week.
 */
const EMITTERS = new Set(
	Object.entries(EVENT_TYPE_ROLES)
		.filter(([, role]) => role !== "observed")
		.map(([type]) => pluginOf(type)),
);

/** Machines whose inventory can say what is installed: live, and reported. */
export function reportingMachines(machines: Machine[]): Machine[] {
	return machines.filter(
		(machine) =>
			machine.revoked_at === null &&
			machine.removed_at === null &&
			machine.inventory_at !== null,
	);
}

/**
 * Onlooker plugins on in some scope of some machine, by bare name. `enabled`
 * null counts: the CLI could not tell, and dropping it would hide a plugin
 * that may be on.
 */
export function installedOnlookerPlugins(inventories: Inventory[]): string[] {
	const names = new Set<string>();
	for (const inventory of inventories) {
		for (const plugin of inventory.plugins) {
			const at = plugin.id.lastIndexOf("@");
			if (at === -1 || plugin.id.slice(at + 1) !== ONLOOKER_MARKETPLACE)
				continue;
			if (plugin.scopes.some((scope) => scope.enabled !== false))
				names.add(plugin.id.slice(0, at));
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Installed plugins no session in `sessions` carried an event from. Heard is
 * read from counts_by_prefix and plugins, which every CLI version sends,
 * rather than counts_by_type, which older ones do not.
 */
export function silentPlugins(
	installed: string[],
	sessions: SessionSummary[],
): string[] {
	const heard = new Set<string>();
	for (const session of sessions) {
		for (const prefix of Object.keys(session.counts_by_prefix))
			heard.add(prefix);
		for (const plugin of session.plugins) heard.add(plugin);
	}
	return installed.filter((name) => EMITTERS.has(name) && !heard.has(name));
}
