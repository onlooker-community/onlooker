import { apiClient } from "./client";

// Machine credentials, as the browser is allowed to see them. Beside
// accountApi.ts and deliberately the same shape: transport - auth header,
// retries, refresh-and-replay on 401 - belongs to client.ts and is not
// re-implemented here.
//
// These endpoints are browser-authenticated by design. A machine token cannot
// mint another one, which is what makes revoking a stolen laptop actually
// revoke it rather than leave behind the credentials it issued for itself.

export const MACHINE_ENDPOINTS = {
	machines: "/api/machines",
} as const;

/**
 * A machine as the list returns it: everything except anything that can be
 * used to authenticate. Mirrors MachineTokenSummary in apps/api.
 *
 * `last_used_at` is null for a machine no plugin has ever presented, and that
 * null is load-bearing - it is the difference the page renders as "Never used"
 * rather than as a blank cell.
 */
export interface Machine {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
	/**
	 * When this machine last reported what it runs, or null for never.
	 *
	 * Load-bearing in the same way `last_used_at` is: the page renders never
	 * reported differently from an inventory naming no plugins, because
	 * "nothing is installed" and "this machine has never told us" are
	 * different claims and only one of them is knowable.
	 */
	inventory_at: string | null;
	/** Plugins the reported inventory names. Null when nothing was reported. */
	plugin_count: number | null;
}

/** One place a plugin is installed on a machine, and what is installed there. */
export interface InventoryScope {
	/** `"user"`, or a home-relative project path like `~/src/foo`. */
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	/** `null` means unknowable - a project the reporting machine did not open. */
	enabled: boolean | null;
}

export interface InventoryPlugin {
	id: string;
	scopes: InventoryScope[];
}

export interface Inventory {
	schema_version: number;
	collected_at: string;
	project: string | null;
	plugins: InventoryPlugin[];
}

/**
 * The create response, and the only moment the raw token exists anywhere the
 * browser can read it. It is never stored and never re-fetchable, which is why
 * `token` is on this type and not on `Machine`.
 */
export interface MintedMachine {
	id: string;
	name: string;
	token: string;
}

export function listMachines(): Promise<{ machines: Machine[] }> {
	return apiClient.get<{ machines: Machine[] }>(MACHINE_ENDPOINTS.machines);
}

export function createMachine(name: string): Promise<MintedMachine> {
	return apiClient.post<MintedMachine>(MACHINE_ENDPOINTS.machines, { name });
}

/**
 * One machine's full inventory document.
 *
 * Separate from `listMachines` on purpose: the list carries a count, this
 * carries the document. Folding it into the list would send every machine's
 * whole inventory to render a page that shows one.
 */
export function getMachineInventory(
	id: string,
): Promise<{ inventory: Inventory; inventory_at: string }> {
	return apiClient.get<{ inventory: Inventory; inventory_at: string }>(
		`${MACHINE_ENDPOINTS.machines}/${encodeURIComponent(id)}/inventory`,
	);
}

export function revokeMachine(id: string): Promise<{ success: boolean }> {
	return apiClient.delete<{ success: boolean }>(
		`${MACHINE_ENDPOINTS.machines}/${encodeURIComponent(id)}`,
	);
}
