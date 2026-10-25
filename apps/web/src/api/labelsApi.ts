import { apiClient } from "./client";

// A user's names for their project keys (ONL-189). Beside sessionsApi.ts and
// deliberately the same shape: transport belongs to client.ts.
//
// Browser-authenticated, and the user is the only writer: a name exists here
// because someone typed it, never because a path or an origin URL left their
// machine. The CLI's opt-in upload is a separate route (ONL-197).

export const LABEL_ENDPOINTS = {
	labels: "/api/project-labels",
} as const;

/**
 * One label as the API returns it. `machine_id` is null for a remote key and
 * the reporting machine for a root key - the scoping ProjectRollup carries.
 */
export interface ProjectLabel {
	project_key: string;
	machine_id: string | null;
	label: string;
}

/** Labels by labelIdentity, ready to look up from a ProjectRollup. */
export type LabelMap = ReadonlyMap<string, string>;

/**
 * The key a label is stored under on this side.
 *
 * `\n` cannot appear in a hex key or a machine id, so the pair cannot
 * collide - the delimiter rollupProjects uses for the same reason.
 */
export function labelIdentity(
	projectKey: string,
	machineId: string | null,
): string {
	return `${machineId ?? ""}\n${projectKey}`;
}

export async function listLabels(): Promise<LabelMap> {
	const { labels } = await apiClient.get<{ labels: ProjectLabel[] }>(
		LABEL_ENDPOINTS.labels,
	);
	return new Map(
		labels.map((l) => [labelIdentity(l.project_key, l.machine_id), l.label]),
	);
}

/**
 * Name a key, or clear its name with null. Resolves to what the server
 * stored - trimmed - so the caller shows that rather than what was typed.
 */
export async function setLabel(
	projectKey: string,
	machineId: string | null,
	label: string | null,
): Promise<string | null> {
	// `request` because the client has no put of its own; transport is
	// otherwise identical to get and post.
	const stored = await apiClient.request<{ label: string | null }>(
		"PUT",
		LABEL_ENDPOINTS.labels,
		{ project_key: projectKey, machine_id: machineId, label },
	);
	return stored.label;
}
