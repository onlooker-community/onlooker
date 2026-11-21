import { formatWeek, isoDay, SECTIONS } from "./changelog-entries";

const DAY_MS = 86_400_000;
const FRIDAY = 5;

/**
 * The Saturday-to-Friday week that holds `today` ("YYYY-MM-DD"). Dates in and
 * out are calendar days, never instants, so the runner's timezone can't move
 * a week.
 */
export function weekOf(today: string): { weekStart: string; weekEnd: string } {
	const day = new Date(`${today}T00:00:00Z`);
	if (Number.isNaN(day.valueOf()) || isoDay(day) !== today) {
		throw new Error(`Expected a YYYY-MM-DD date, got "${today}"`);
	}
	const toFriday = (FRIDAY - day.getUTCDay() + 7) % 7;
	const end = new Date(day.valueOf() + toFriday * DAY_MS);
	return {
		weekStart: isoDay(new Date(end.valueOf() - 6 * DAY_MS)),
		weekEnd: isoDay(end),
	};
}

// Hosted feed is left out until the hosted feed opens (plan doc, Nov 20).
const SCAFFOLDED = SECTIONS.filter((s) => s !== "Hosted feed");

const PROMPT =
	"{/* One bullet per change: a bold lead line saying what changed for the reader, then a sentence or two on why it matters. Delete the section if it stays empty. */}";

/** A draft entry for the week, with every heading in place. */
export function scaffold(week: { weekStart: string; weekEnd: string }): string {
	const range = formatWeek(new Date(week.weekStart), new Date(week.weekEnd));
	const sections = SCAFFOLDED.map((s) => `## ${s}\n\n${PROMPT}\n`).join("\n");
	return `---
title: "Draft: ${range}"
weekStart: ${week.weekStart}
weekEnd: ${week.weekEnd}
summary: "Draft. One or two sentences on what changed for readers this week."
# plugins:  # versions from each plugin's own CHANGELOG.md, not the root one
#   - name: lineage
#     version: "0.10.5"
draft: true
---

${sections}
{/* End with what to do, if anything, such as "update these plugins to pick up the fix". */}
`;
}
