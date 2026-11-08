import type { PluginProse } from "./types";

export const archivist: PluginProse = {
	slug: "archivist",
	name: "Archivist",
	tagline: "Memory that survives context truncation.",
	category: "memory",
	problem:
		"Claude Code has a context window. When it fills and compacts, decisions made three hours ago vanish. The agent starts fresh, relitigates closed questions, and re-makes mistakes you already corrected.",
	howItWorks: [
		"On compaction (PreCompact / PostCompact) — Archivist extracts the most important items from the current context: decisions made, approaches ruled out, open questions still in flight.",
		"On session start (SessionStart) — Archivist re-injects the top-ranked items from prior sessions into the new context, ordered by recency and importance.",
	],
};
