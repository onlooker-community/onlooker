import type { PluginProse } from "./types";

export const curator: PluginProse = {
	slug: "curator",
	name: "Curator",
	tagline: "Tends the memory garden.",
	category: "memory",
	problem:
		'A typed memory store accumulates. A project memory says "merge freeze begins 2026-03-05" — the date passes and the rule keeps firing. A reference memory points at scripts/legacy_ingest.py — the file gets deleted and the pointer dangles. MEMORY.md grows entries that no longer have files behind them; the memory dir grows files no one indexes. None of these are individually catastrophic; together they erode the signal-to-noise of every session that consults memory.',
	howItWorks: [
		"SessionStart — runs the cheap-tier audit against ~/.claude/projects/<encoded-project>/memory/, inside a 500ms wall-clock budget; skips if the session is younger than 5 seconds (avoids storm on rapid restarts)",
		"Reads MEMORY.md and the referenced memory files; parses frontmatter (name, description, type) and the body of each",
		"Date check — scans bodies for ISO-8601 dates; flags any more than date_grace_period_days (default: 14) in the past",
		"Reference check — extracts path-shaped tokens, resolves against the repo root, flags paths that no longer exist",
	],
};
