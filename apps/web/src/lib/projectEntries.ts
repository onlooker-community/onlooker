import { type LabelMap, labelIdentity } from "../api/labelsApi";
import type { Project } from "../api/projectsApi";

// What a project filter offers (ONL-209). One entry per name, because someone
// who named an https clone and an ssh clone the same has said they are one.
// The name stops here: the server is sent keys, so a CLI label (ONL-197) can
// only change the grouping.

/** One choice in a filter. */
export interface ProjectEntry {
	name: string;
	/** What `project` carries to the API, for every key under this name. */
	values: string[];
}

/** The user's name for a key, or the key. `machineId` is null when remote. */
export function projectName(
	key: string,
	machineId: string | null,
	labels: LabelMap,
): string {
	return labels.get(labelIdentity(key, machineId)) ?? key;
}

export function projectEntries(
	projects: Project[],
	labels: LabelMap,
): ProjectEntry[] {
	const entries = new Map<string, string[]>();
	for (const { project_key: key, machine_id: machineId } of projects) {
		const name = projectName(key, machineId, labels);
		const value = machineId === null ? key : `${machineId}:${key}`;
		entries.set(name, [...(entries.get(name) ?? []), value]);
	}
	return [...entries]
		.map(([name, values]) => ({ name, values }))
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
}
