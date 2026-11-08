import type { PluginProse } from "./types";

export const tribunal: PluginProse = {
	slug: "tribunal",
	name: "Tribunal",
	tagline: "Don't ship what only one agent approved.",
	category: "quality",
	problem:
		"Single-pass AI output has no check on itself. The agent that wrote the code also decides it's done. There's no adversarial review, no bias check, no structured retry. Either a human reviews everything — or nothing gets reviewed at all.",
	howItWorks: [
		"Actor performs the work",
		"Jury — N typed Judges score the output independently against a rubric",
		"Meta-Judge — reviews the jury's verdicts for bias, hallucination, and criteria misapplication",
		"Gate — aggregates verdicts under the configured policy (majority / strict / unanimous)",
	],
};
