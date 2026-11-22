/**
 * What the sessions page loaded, said in one sentence.
 *
 * This component states only what the rollup counted. When `complete` is
 * false the wording changes from a total to "the most recent N" - the numbers
 * are the same either way, and the difference is whether the page is claiming
 * they describe the account's whole history. The fetch is newest-first across
 * all time rather than a calendar query, so "this week" is a claim the data
 * cannot back; the range says which dates the loaded rows actually span.
 *
 * It was a lead sentence over a panel of per-day bars. The bars are gone: each
 * day's section below now carries its own count and time beside its heading,
 * which says the same thing in the place it belongs, and a chart above the
 * feed was a second feed's worth of scrolling before the first row.
 *
 * Presentational: it decides nothing. lib/sessionRollup.ts does the
 * arithmetic, and SessionsPage decides whether this renders at all.
 */

import { formatDurationMs, plural, type Rollup } from "../lib/sessionRollup";
import { AllSpawned, SpawnedTail } from "./SpawnedSessions";
import { Lead, LeadValue } from "./ui";

export default function SessionsSummary({
	rollup,
	failedSessions = 0,
}: {
	rollup: Rollup;
	/** How many of the loaded sessions had a plugin fail. Zero says nothing. */
	failedSessions?: number;
}) {
	// Not an empty state - SessionsPage owns those, and its three variants say
	// different true things about machines. Rendering nothing lets them speak.
	if (rollup.sessions === 0 && rollup.subordinate === 0) return null;

	const total = formatDurationMs(rollup.durationMs);
	const counted = plural(rollup.sessions, "session");

	// An incomplete read says "most recent" for the reason in the doc comment
	// above: the rows loaded are not the whole history, and a total would
	// claim they are.
	const tail = total ? (
		<>
			, <LeadValue>{total}</LeadValue> in all
		</>
	) : null;
	const span = rollup.range ? `, across ${rollup.range}` : "";
	// A second sentence, only when there is something to say: a clean run of
	// sessions needs no line announcing that nothing went wrong.
	const failedTail =
		failedSessions > 0 ? (
			<>
				{" "}
				Plugins failed in{" "}
				<LeadValue>{failedSessions.toLocaleString()}</LeadValue> of them.
			</>
		) : null;
	// The rows below list every loaded session, spawned ones included, so a
	// count that leaves some out has to say so or it reads as a miscount.
	const subordinateTail = <SpawnedTail n={rollup.subordinate} />;

	// Nothing counted, so no range, duration or failures to describe.
	if (rollup.sessions === 0) {
		return (
			<Lead testId="sessions-headline">
				<AllSpawned n={rollup.subordinate} complete={rollup.complete} />
			</Lead>
		);
	}

	return (
		<Lead testId="sessions-headline">
			{rollup.complete ? (
				<>
					Your machines reported <LeadValue>{counted}</LeadValue>
					{tail}
					{span}.{failedTail}
					{subordinateTail}
				</>
			) : (
				<>
					The most recent <LeadValue>{counted}</LeadValue> your machines
					reported{tail}
					{span}.{failedTail}
					{subordinateTail}
				</>
			)}
		</Lead>
	);
}
