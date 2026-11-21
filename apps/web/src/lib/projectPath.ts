/**
 * Where a project's own page lives.
 *
 * A remote key names one repository on every machine; a root key hashes a
 * local path, so it only means something on the machine that reported it and
 * the machine rides along as a query. Keys are 12 hex characters, so the
 * path needs no escaping, but the machine id is encoded all the same.
 */
export function projectPath(key: string, machineId: string | null): string {
	const base = `/projects/${encodeURIComponent(key)}`;
	return machineId === null
		? base
		: `${base}?machine=${encodeURIComponent(machineId)}`;
}

/** What the sessions read filters on for one project: `<key>` or `<machine>:<key>`. */
export function sessionFilterValue(
	key: string,
	machineId: string | null,
): string {
	return machineId === null ? key : `${machineId}:${key}`;
}
