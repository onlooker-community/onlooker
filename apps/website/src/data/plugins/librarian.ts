import type { PluginProse } from "./types";

export const librarian: PluginProse = {
	slug: "librarian",
	name: "Librarian",
	tagline: "Promotes what's worth keeping.",
	category: "memory",
	problem:
		'A user explains why the auth middleware is being rewritten — legal compliance, not tech debt. Archivist captures it as a decision; recency re-injects it for a few sessions; eventually it ages out, and the agent asks "why are we rewriting this?" all over again. The typed memory store could have absorbed the fact, but only if the user thought to say "remember that." Most don\'t. The store stays starved, archivist re-captures the same facts every session, and the agent re-asks the same questions.',
	howItWorks: [
		"SessionEnd — scans archivist artifacts (decisions, dead_ends, open_questions) created since the last librarian watermark, bootstrapping over bootstrap_lookback_days (default: 14) on first run",
		'Durability filter — cheap pre-LLM pass keeps candidates that show signs of lasting: marker phrases ("always", "never", "the reason"), path grounding, repetition across ≥2 sessions; drops short-detail noise',
		'Type classifier — single Haiku call per candidate emits one of user/feedback/project/reference (or null for "session-only — don\'t promote"); confidence floor of 0.6 drops the noisy tail',
		"Conflict + duplicate detector — Jaccard similarity against existing memory files; classifies each candidate as none / duplicate / merge_candidate / conflict_candidate (cheap pattern matching, not an LLM call — curator handles deep contradictions)",
	],
};
