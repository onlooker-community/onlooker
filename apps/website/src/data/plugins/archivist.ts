import type { PluginProse } from "./types";

export const archivist: PluginProse = {
	slug: "archivist",
	name: "Archivist",
	tagline: "Memory that survives context truncation.",
	category: "memory",
	problem:
		"Claude Code has a context window. When a long conversation compacts, the decisions made earlier in it can go with it. The agent carries on without them, relitigates closed questions, and repeats mistakes you already corrected. Archivist keeps the decisions, dead ends and open questions outside the window.",
	howItWorks: [
		"On PreCompact, Archivist reads the transcript tail, asks claude -p to extract the decisions made, dead ends hit and open questions raised, drops any file path that does not exist in the repo, and writes the rest as artifacts for the project.",
		"On SessionStart, it loads the project's artifacts, ranks pinned ones first and the rest by recency, and injects them as invisible context within a token budget.",
		"On SessionEnd, it also mines commits on the default branch since a per-project watermark into decision artifacts, capped per session so a backlog clears over a few sessions.",
		"Artifacts are keyed to the project's git remote, so one repo's memory never surfaces in another.",
	],
};
