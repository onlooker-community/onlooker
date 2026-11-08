import type { PluginProse } from "./types";

export const scribe: PluginProse = {
	slug: "scribe",
	name: "Scribe",
	tagline: "The why your git log will never show.",
	category: "analysis",
	problem:
		"When a session ends, the reasoning evaporates. You can git-blame the change, but not the decision. Why this approach over that one? What alternatives were ruled out? What constraints shaped the work? That context lives in the conversation — and the conversation window closes.",
	howItWorks: [
		"On SessionStart — captures the initial user prompt as the session's opening context",
		"On each UserPromptSubmit — counts turns to determine if the session is substantial enough to document (configurable minimum, default 3)",
		"On Stop — reads the full session transcript and runs a Haiku extraction pass to identify the problem, decisions (with reasons and alternatives considered), tradeoffs, constraints, and what was explicitly left out",
		"Formats findings as a structured Markdown document named <date>-<session>.md",
	],
};
