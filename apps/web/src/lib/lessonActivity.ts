/**
 * What the lesson feed says happened, in the words both ActivityPage and the
 * home page's Lessons panel use (ONL-298), so the two cannot word one event
 * differently.
 *
 * Pure, like the other home rollups.
 */

import type { ActivityEvent } from "../api/lessonsApi";
import { plural } from "./sessionRollup";

/**
 * What happened, in the order the feed recorded it.
 *
 * A `status` row says only that the status changed. lesson_feed has no from/to
 * columns, and naming the lesson's CURRENT status on a past event would be
 * wrong for anything that changed twice - a lesson retracted in March and
 * reinstated in April would show both events as "active". See the design spec.
 */
export function describeKind(kind: string): string {
	if (kind === "create") return "Published";
	if (kind === "status") return "Status changed";
	return kind;
}

export interface ActivityTally {
	published: number;
	statusChanges: number;
	/** Every event, including kinds newer than this build. */
	total: number;
}

export function tallyActivity(events: ActivityEvent[]): ActivityTally {
	let published = 0;
	let statusChanges = 0;
	for (const event of events) {
		if (event.kind === "create") published += 1;
		else if (event.kind === "status") statusChanges += 1;
	}
	return { published, statusChanges, total: events.length };
}

/**
 * "2 published · 1 status change in the last 7 days". Capped, it says "in
 * your latest N events" instead, for the reason the sessions headline says
 * "most recent": the rows loaded are not the whole window.
 */
export function describeLessonWeek(
	tally: ActivityTally,
	complete: boolean,
): string {
	const parts: string[] = [];
	if (tally.published > 0)
		parts.push(`${tally.published.toLocaleString()} published`);
	if (tally.statusChanges > 0)
		parts.push(plural(tally.statusChanges, "status change"));
	// Only a kind newer than this build leaves both at zero.
	if (parts.length === 0) parts.push(plural(tally.total, "event"));
	const counted = parts.join(" · ");
	return complete
		? `${counted} in the last 7 days`
		: `${counted} in your latest ${plural(tally.total, "event")}`;
}
