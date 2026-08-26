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

export function revokeMachine(id: string): Promise<{ success: boolean }> {
	return apiClient.delete<{ success: boolean }>(
		`${MACHINE_ENDPOINTS.machines}/${encodeURIComponent(id)}`,
	);
}
