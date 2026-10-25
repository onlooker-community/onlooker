import type { D1Database } from "@cloudflare/workers-types";

/**
 * A user's name for one project key, as the browser sees it (ONL-189).
 *
 * `machine_id` is null for a remote key and the reporting machine for a root
 * key - the shape rollupProjects gives ProjectRollup. Stored as '' rather than
 * null (see project_labels in packages/db/src/schema.ts); this module is the
 * only place that translates.
 */
export interface ProjectLabel {
	project_key: string;
	machine_id: string | null;
	label: string;
}

/**
 * Every label this user has typed.
 *
 * Only `source = 'user'`: nothing else writes rows yet. When ONL-197 adds
 * `'cli'`, this is where the user's label is preferred over the CLI's.
 */
export async function listProjectLabels(
	db: D1Database,
	userId: string,
): Promise<ProjectLabel[]> {
	const { results } = await db
		.prepare(
			`SELECT project_key, machine_id, label FROM project_labels
			  WHERE user_id = ? AND source = 'user'
			  ORDER BY project_key, machine_id`,
		)
		.bind(userId)
		.all<{ project_key: string; machine_id: string; label: string }>();
	return results.map((row) => ({
		project_key: row.project_key,
		machine_id: row.machine_id === "" ? null : row.machine_id,
		label: row.label,
	}));
}

/** Whether `machineId` is one of this user's machines, revoked or not. */
export async function ownsMachine(
	db: D1Database,
	userId: string,
	machineId: string,
): Promise<boolean> {
	// Revoked machines count: their sessions stay in the feed, so their root
	// keys still need a name there.
	const row = await db
		.prepare("SELECT 1 FROM machine_tokens WHERE id = ? AND user_id = ?")
		.bind(machineId, userId)
		.first();
	return row !== null;
}

/** Name a key, replacing the user's previous name for it. */
export async function setProjectLabel(
	db: D1Database,
	userId: string,
	label: ProjectLabel,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO project_labels (user_id, project_key, machine_id, source, label)
			 VALUES (?, ?, ?, 'user', ?)
			 ON CONFLICT (user_id, project_key, machine_id, source)
			 DO UPDATE SET label = excluded.label, updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(userId, label.project_key, label.machine_id ?? "", label.label)
		.run();
}

/** Remove the user's name for a key, so the web falls back to the hash. */
export async function clearProjectLabel(
	db: D1Database,
	userId: string,
	projectKey: string,
	machineId: string | null,
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM project_labels
			  WHERE user_id = ? AND project_key = ? AND machine_id = ?
			    AND source = 'user'`,
		)
		.bind(userId, projectKey, machineId ?? "")
		.run();
}
