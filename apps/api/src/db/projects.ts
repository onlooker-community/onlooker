import type { D1Database } from "@cloudflare/workers-types";
import { listProjectLabels } from "./project-labels.js";

/**
 * One project as the Projects page lists it (ONL-209).
 *
 * A remote key means the same repository on every machine, so it has one row.
 * A root key hashes a local path, so it has one per machine.
 *
 * `basis` is null for a key known only from a lesson, which records none.
 */
export interface Project {
	project_key: string;
	basis: "remote" | "root" | null;
	machine_id: string | null;
	sessions: number;
	events: number;
	last_seen_at: string | null;
}

/**
 * This user's projects, most recently seen first.
 *
 * Labels are read too, so a project does not vanish once its sessions pass
 * retention: the name is the user's, and it should stay findable.
 */
export async function listProjects(
	db: D1Database,
	userId: string,
): Promise<Project[]> {
	const { results } = await db
		.prepare(
			`SELECT p.project_key, p.basis,
			        CASE p.basis WHEN 'root' THEN p.machine_id END AS machine_id,
			        COUNT(*) AS sessions,
			        SUM(p.event_count) AS events,
			        MAX(s.started_at) AS last_seen_at
			   FROM session_projects p
			   JOIN session_summaries s
			     ON s.machine_id = p.machine_id AND s.session_id = p.session_id
			  WHERE p.user_id = ?
			  GROUP BY p.project_key, p.basis,
			           CASE p.basis WHEN 'root' THEN p.machine_id END`,
		)
		.bind(userId)
		.all<Project>();

	const identity = (key: string, machineId: string | null) =>
		`${machineId ?? ""}\n${key}`;
	const seen = new Set(
		results.map((row) => identity(row.project_key, row.machine_id)),
	);
	const labeled: Project[] = (await listProjectLabels(db, userId))
		.filter((label) => !seen.has(identity(label.project_key, label.machine_id)))
		.map((label) => ({
			project_key: label.project_key,
			basis: label.machine_id === null ? "remote" : "root",
			machine_id: label.machine_id,
			sessions: 0,
			events: 0,
			last_seen_at: null,
		}));

	// ISO timestamps sort as text. Never seen goes last, then by key so the
	// order is stable.
	return [...results, ...labeled].sort(
		(a, b) =>
			(b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "") ||
			a.project_key.localeCompare(b.project_key) ||
			(a.machine_id ?? "").localeCompare(b.machine_id ?? ""),
	);
}
