import type { PluginProse } from "./types";

export const cartographer: PluginProse = {
	slug: "cartographer",
	name: "Cartographer",
	tagline: "Your instruction files are a codebase. Audit them like one.",
	category: "analysis",
	problem:
		"You have a CLAUDE.md at the root, more in subdirectories, AGENTS.md files, and .claude/rules/, and they grow organically. Two rules contradict each other. A rule is subsumed by a more specific one elsewhere. A reference points at a file that no longer exists. A project rule quietly overrides a global one. Nobody notices until the agent does something wrong.",
	howItWorks: [
		"On SessionStart, Cartographer audits your CLAUDE.md, AGENTS.md and .claude/rules/ files in a detached background process, once enough time has passed since the last audit, so the session is not blocked.",
		"It builds a semantic map of how those files relate, using claude -p, and reports contradictions, dead rules, stale references, scope collisions, and things on disk that no instruction file mentions.",
		"/cartographer runs a full audit in the foreground. --status, --verbose, --force, --type and --scope adjust it.",
		"Findings are stored locally and emitted as cartographer.issue.found events. A full audit that no longer sees a finding marks it resolved. Cartographer never edits an instruction file or blocks a write.",
	],
};
