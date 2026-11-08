import type { PluginProse } from "./types";

export const echo: PluginProse = {
	slug: "echo",
	name: "Echo",
	tagline: "A measurement harness for LLM judges, not a runtime gate.",
	category: "testing",
	problem:
		"Echo once scored changed agent files against a stored baseline and reported whether each edit improved or degraded them. It was measured twice and did not work: the judge could not tell two different documents apart more reliably than it reproduced its own score on one. The runtime was retired (ONL-103). Echo now ships no hooks and does not score your prompts as you work. What remains is the instrument that measured it.",
	howItWorks: [
		"Echo asks one question of any LLM judge: does it discriminate between different inputs more reliably than it reproduces itself on identical input?",
		"Two runners answer it: one measures the spread of absolute scores on identical content, the other tests pairwise comparison for self-ties, position bias and repeatability.",
		"Each run writes raw per-call results beside the computed statistics, stamped with the model and a prompt fingerprint.",
	],
};
