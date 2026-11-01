import { apiClient } from "./client";

// The viewer's project keys and their activity (ONL-209). Names come from
// labelsApi.ts: a name is the user's, this is what the server saw.

export const PROJECT_ENDPOINTS = {
	projects: "/api/projects",
} as const;

/** `basis` is null for a key known only from a lesson, which records none. */
export interface Project {
	project_key: string;
	basis: "remote" | "root" | null;
	machine_id: string | null;
	sessions: number;
	events: number;
	last_seen_at: string | null;
}

export function listProjects(): Promise<{ projects: Project[] }> {
	return apiClient.get<{ projects: Project[] }>(PROJECT_ENDPOINTS.projects);
}
