import type { PluginProse } from "./types";

export const tribunal: PluginProse = {
	slug: "tribunal",
	name: "Tribunal",
	tagline: "Don't ship what only one agent approved.",
	category: "quality",
	problem:
		"Single-pass output has no check on itself: the agent that wrote the code also decides it is done. Tribunal puts an adversarial review, a bias check and a structured retry between the work and its acceptance.",
	howItWorks: [
		"/tribunal <task> runs an Actor subagent, then hands its output to a jury of typed Judges who score it against a rubric. A project can override the rubric.",
		"A Meta-Judge reviews the jury for bias, hallucination and criteria misapplication.",
		"A gate policy decides whether to accept, retry or give up. On a retry the Actor receives the Judges' critiques, until the gate passes or the iteration limit is reached.",
		"An opt-in Stop hook runs one advisory pass over the files the session edited and writes a verdict for review in the next session. It does not retry.",
	],
};
