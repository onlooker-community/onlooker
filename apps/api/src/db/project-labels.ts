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
 * Every label this user has, one per key.
 *
 * The user's label when there is one, otherwise the one the CLI derived
 * (ONL-197).
 */
export async function listProjectLabels(
	db: D1Database,
	userId: string,
): Promise<ProjectLabel[]> {
	// 'user' sorts after 'cli', so within one (key, machine) the user's row
	// is read last and overwrites the CLI's in the map below.
	const { results } = await db
		.prepare(
			`SELECT project_key, machine_id, label FROM project_labels
			  WHERE user_id = ? AND source IN ('cli', 'user')
			  ORDER BY project_key, machine_id, source`,
		)
		.bind(userId)
		.all<{ project_key: string; machine_id: string; label: string }>();
	const byIdentity = new Map<string, ProjectLabel>();
	for (const row of results) {
		byIdentity.set(`${row.machine_id}\n${row.project_key}`, {
			project_key: row.project_key,
			machine_id: row.machine_id === "" ? null : row.machine_id,
			label: row.label,
		});
	}
	return [...byIdentity.values()];
}

/** The label the list shows for one key: the user's, else the CLI's. */
export async function labelFor(
	db: D1Database,
	userId: string,
	projectKey: string,
	machineId: string | null,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT label FROM project_labels
			  WHERE user_id = ? AND project_key = ? AND machine_id = ?
			    AND source IN ('cli', 'user')
			  ORDER BY source DESC LIMIT 1`,
		)
		.bind(userId, projectKey, machineId ?? "")
		.first<{ label: string }>();
	return row?.label ?? null;
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

/** One label a machine derived, before the server scopes it. */
export interface CliLabelInput {
	project_key: string;
	basis: "remote" | "root";
	label: string;
}

/**
 * Store labels the CLI derived, each only if this machine reported that key
 * under that basis (ONL-197, problem 1). Remote rows are shared, so the last
 * machine to write one owns it; root rows belong to this machine alone.
 */
export async function putCliLabels(
	db: D1Database,
	userId: string,
	machineId: string,
	labels: CliLabelInput[],
): Promise<{ stored: number; skipped: number }> {
	if (labels.length === 0) return { stored: 0, skipped: 0 };
	const { results } = await db
		.prepare(
			`SELECT DISTINCT project_key, basis FROM session_projects
			  WHERE user_id = ? AND machine_id = ?`,
		)
		.bind(userId, machineId)
		.all<{ project_key: string; basis: string }>();
	const reported = new Set(results.map((r) => `${r.basis}\n${r.project_key}`));

	const writes = labels
		.filter((l) => reported.has(`${l.basis}\n${l.project_key}`))
		.map((l) =>
			db
				.prepare(
					`INSERT INTO project_labels (user_id, project_key, machine_id, source, label, written_by)
					 VALUES (?, ?, ?, 'cli', ?, ?)
					 ON CONFLICT (user_id, project_key, machine_id, source)
					 DO UPDATE SET label = excluded.label, written_by = excluded.written_by,
					               updated_at = CURRENT_TIMESTAMP`,
				)
				.bind(
					userId,
					l.project_key,
					l.basis === "root" ? machineId : "",
					l.label,
					machineId,
				),
		);
	if (writes.length > 0) await db.batch(writes);
	return { stored: writes.length, skipped: labels.length - writes.length };
}

/** Remove the CLI labels this machine wrote last; the user's stay. */
export async function deleteCliLabels(
	db: D1Database,
	userId: string,
	machineId: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM project_labels
			  WHERE user_id = ? AND source = 'cli' AND written_by = ?`,
		)
		.bind(userId, machineId)
		.run();
	return result.meta.changes ?? 0;
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
