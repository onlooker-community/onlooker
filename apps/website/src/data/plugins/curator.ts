import type { PluginProse } from "./types";

export const curator: PluginProse = {
	slug: "curator",
	name: "Curator",
	tagline: "Tends the memory garden.",
	category: "memory",
	problem:
		'A typed memory store accumulates. A project memory says "merge freeze begins 2026-03-05", and the date passes while the rule keeps firing. A reference memory points at scripts/legacy_ingest.py, and the file gets deleted. MEMORY.md keeps entries with no file behind them, and the memory directory grows files nothing indexes. None of this is catastrophic alone; together it erodes the signal in every session that consults memory.',
	howItWorks: [
		"On SessionStart, Curator runs cheap heuristic checks against the memories at ~/.claude/projects/<encoded-project>/memory/, inside a wall-clock budget.",
		"The checks look for deadlines past their grace period, path references that no longer resolve, MEMORY.md entries with no file behind them, and memory files that nothing indexes.",
		"Findings are written under ~/.onlooker/curator/<project-key>/findings/, and repeat findings are deduplicated.",
		"Curator never edits the memory store. The one-line SessionStart pointer to open findings stays off until /curator review ships.",
	],
};
