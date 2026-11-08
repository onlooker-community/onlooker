import type { PluginProse } from "./types";

export const cartographer: PluginProse = {
	slug: "cartographer",
	name: "Cartographer",
	tagline: "Your instruction files are a codebase. Audit them like one.",
	category: "analysis",
	problem:
		"You have a CLAUDE.md at the root, more in subdirectories, AGENTS.md files, and .claude/rules/. They've grown organically. A rule written last year shadows a more specific rule you wrote last week. Two rules silently contradict each other. A reference points to a file that no longer exists. Nobody knows — until the agent does something wrong.",
	howItWorks: [
		"Collect — discovers every instruction file in the repo",
		"Extract — builds a semantic map of each file's rules using Haiku",
		"Synthesize — compares maps across files, identifies conflicts and gaps",
		"Surface — findings available via /cartographer or the event log",
	],
};
