/**
 * What a sessions headline says about the sessions it left out (ONL-221).
 *
 * Another session or a script started them, and the rollup does not count
 * them. A count that leaves rows out has to say so or it reads as a miscount.
 * SessionsSummary and HomeSessionsPanel both say it, so the wording lives here
 * once.
 */

import { plural } from "../lib/sessionRollup";
import { LeadValue } from "./ui";

/** The sentence that follows a counted headline: "3 more were started ...". */
export function SpawnedTail({ n }: { n: number }) {
	if (n <= 0) return null;
	return (
		<>
			{" "}
			<LeadValue>{n.toLocaleString()}</LeadValue> more{" "}
			{n === 1 ? "was" : "were"} started by another session or a script and{" "}
			{n === 1 ? "isn't" : "aren't"} counted.
		</>
	);
}

/**
 * The whole headline when every loaded session was spawned, so nothing was
 * counted for the usual range, duration and failure sentences to describe.
 *
 * `intro` leads the complete form ("Your machines reported"); a caller whose
 * headline opens differently passes its own. The capped form is the same on
 * every page.
 */
export function AllSpawned({
	n,
	complete,
	intro = "Your machines reported",
}: {
	n: number;
	complete: boolean;
	intro?: string;
}) {
	// No sessions at all is the caller's empty state, not "all spawned".
	if (n <= 0) return null;
	const count = <LeadValue>{plural(n, "session")}</LeadValue>;
	const one = n === 1;
	if (complete) {
		return (
			<>
				{intro} {count},{" "}
				{one
					? "started by another session or a script, so it isn't counted."
					: "all started by another session or a script, so none are counted."}
			</>
		);
	}
	return one ? (
		<>
			The most recent session your machines reported was started by another
			session or a script, so it isn't counted.
		</>
	) : (
		<>
			The most recent {count} your machines reported were all started by another
			session or a script, so none are counted.
		</>
	);
}
