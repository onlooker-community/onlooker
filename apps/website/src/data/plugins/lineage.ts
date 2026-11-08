import type { PluginProse } from "./types";

export const lineage: PluginProse = {
	slug: "lineage",
	name: "Lineage",
	tagline: "Why does this line exist?",
	category: "analysis",
	problem:
		"A reviewer opens a file and asks why a conditional is there. Git records what changed and Scribe records a session's intent, but nothing connects a specific piece of code to the prompt, agent and session that produced it. The why behind a line is gone once the session closes.",
	howItWorks: [
		"On PostToolUse for Edit, Write, MultiEdit and Bash, Lineage derives the project key from cwd and reads the current turn from the session tracker. For Bash it asks git which files changed, so a heredoc or sed -i still lands in the ledger.",
		"It extracts each change's added content, redacts secret-shaped substrings, caps the size, and appends a record to a per-project change ledger. The event on the bus carries metadata and a digest, never the content.",
		"/lineage <file>:<line> finds the most recent change whose added content contains that line, then resolves the originating prompt from the transcripts historian preserves, falling back to the live transcript. The query makes no model call.",
		"Bash records say how far to trust them: whether the captured content is exactly this change or includes earlier uncommitted work, and a change that predates the command is recorded with unknown authorship.",
	],
};
