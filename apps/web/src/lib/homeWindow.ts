/**
 * The home page's window: today and the six days before it, in the reader's
 * own timezone (ONL-298).
 *
 * Calendar days rather than 168 hours, so the seven day bars and the headline
 * count describe the same rows. A 168-hour window would count a session from
 * seven days ago this afternoon that no bar shows.
 *
 * Pure, with `now` passed in, so tests pin the clock without faking timers.
 */

import { dayKey } from "./dayKey";

export const WINDOW_DAYS = 7;

/** Local midnight at the start of the window. */
export function windowStart(now: Date): Date {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (WINDOW_DAYS - 1));
	return start;
}

/**
 * The window's days, today first, labeled the way `dayKey` labels a row - so
 * they match `rollupSessions`'s `days[].day` exactly.
 */
export function windowDays(now: Date): string[] {
	const start = windowStart(now);
	return Array.from({ length: WINDOW_DAYS }, (_, i) => {
		const day = new Date(start);
		day.setDate(start.getDate() + (WINDOW_DAYS - 1 - i));
		return dayKey(day.toISOString());
	});
}

export interface Windowed<T> {
	/** The rows inside the window, in their input order. */
	rows: T[];
	/**
	 * True when `rows` is every row the window holds: the API has no more
	 * pages, or a loaded row already falls before the window's start, so the
	 * unloaded pages are older still. Relies on newest-first input, which is
	 * what /api/sessions and /api/activity both return.
	 */
	complete: boolean;
}

export function withinWindow<T>(
	rows: T[],
	at: (row: T) => string,
	now: Date,
	hasMore: boolean,
): Windowed<T> {
	const start = windowStart(now).getTime();
	const inside: T[] = [];
	let reachedBefore = false;
	for (const row of rows) {
		const time = new Date(at(row)).getTime();
		// In no window, and in no day bar either.
		if (Number.isNaN(time)) continue;
		if (time >= start) inside.push(row);
		else reachedBefore = true;
	}
	return { rows: inside, complete: !hasMore || reachedBefore };
}
