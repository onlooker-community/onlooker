/**
 * The day an ISO timestamp belongs to, in the reader's own timezone.
 *
 * Shared by ActivityPage and SessionsPage, which both group their rows into a
 * Panel per day. Originally a local function on ActivityPage; pulled out
 * rather than copied a second time for the same reason LoadMore was - see
 * that component's doc comment on the two copies of a "few lines" that had
 * already drifted apart on a character by the time anyone noticed.
 */
export function dayKey(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

/** The time of day an ISO timestamp falls at, in the reader's own timezone. */
export function timeOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(undefined, { timeStyle: "short" });
}
