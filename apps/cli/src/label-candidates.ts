import type { SessionStart } from "./eventlog";

const KEY = /^[0-9a-f]{12}$/;

/** One key a machine reported, and the directories it was seen in. */
export interface Candidate {
	key: string;
	basis: "remote" | "root";
	/** Newest first, so a directory since deleted is tried after a live one. */
	dirs: string[];
}

/**
 * Folds `session.start` records into label candidates over the same window
 * `reportSessions` reports, fed by `readEventEnvelopes`'s `onSessionStart`
 * so the 200 MB log is read once.
 */
export class CandidateCollector {
	private readonly byKey = new Map<
		string,
		{ basis: Candidate["basis"]; dirs: Map<string, string> }
	>();

	constructor(private readonly since: string) {}

	add(start: SessionStart): void {
		if (start.timestamp < this.since || !KEY.test(start.project)) return;
		const id = `${start.project_basis}\n${start.project}`;
		const entry = this.byKey.get(id) ?? {
			basis: start.project_basis,
			dirs: new Map(),
		};
		const seen = entry.dirs.get(start.working_directory);
		if (seen === undefined || seen < start.timestamp) {
			entry.dirs.set(start.working_directory, start.timestamp);
		}
		this.byKey.set(id, entry);
	}

	candidates(): Candidate[] {
		return [...this.byKey].map(([id, entry]) => ({
			key: id.slice(id.indexOf("\n") + 1),
			basis: entry.basis,
			dirs: [...entry.dirs]
				.sort((a, b) => b[1].localeCompare(a[1]))
				.map(([dir]) => dir),
		}));
	}
}
