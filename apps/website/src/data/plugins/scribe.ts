import type { PluginProse } from "./types";

export const scribe: PluginProse = {
	slug: "scribe",
	name: "Scribe",
	tagline: "The why your git log will never show.",
	category: "analysis",
	problem:
		"When a session ends, the reasoning evaporates. You can git-blame the change, but not the decision. Why this approach over that one? What alternatives were ruled out? What constraints shaped the work? That context lives in the conversation, and the conversation window closes.",
	howItWorks: [
		"SessionStart sets up the session's state; the first UserPromptSubmit stores its prompt (truncated) as the problem-statement seed. Later prompts are ignored, since the full transcript is available at Stop.",
		"On Stop, it reads the full transcript and runs a single claude -p extraction pass for the problem, the decisions with their reasons and rejected alternatives, the tradeoffs, the constraints, and what was left out of scope.",
		"The result is a Markdown intent document written under ~/.onlooker/scribe/<project-key>/, named by date and session. It can also be mirrored into your repo tree when you turn that on.",
		"A session with too few user turns, or no readable transcript, is skipped silently. Every hook exits 0, so Scribe never blocks a session.",
	],
};
