import type { PluginData } from "./types";

export const tribunal: PluginData = {
	slug: "tribunal",
	name: "Tribunal",
	version: "1.0.1",
	tagline: "Don't ship what only one agent approved.",
	category: "quality",

	hero: {
		headline: "Multi-agent quality gates with LLM-as-a-Judge.",
		subheadline:
			"Tribunal routes completed work through a jury of independent judges, checks the jury for bias, and decides: accept, retry, or exhaust — grounded in peer-reviewed evaluation methodology.",
	},

	problem:
		"Single-pass AI output has no check on itself. The agent that wrote the code also decides it's done. There's no adversarial review, no bias check, no structured retry. Either a human reviews everything — or nothing gets reviewed at all.",

	howItWorks: [
		"Actor performs the work",
		"Jury — N typed Judges score the output independently against a rubric",
		"Meta-Judge — reviews the jury's verdicts for bias, hallucination, and criteria misapplication",
		"Gate — aggregates verdicts under the configured policy (majority / strict / unanimous)",
		"Decision — accept, retry with critique, or exhaust after max iterations",
	],

	tables: [
		{
			title: "Judge types",
			headers: ["Type", "Lens"],
			rows: [
				["standard", "Correctness, completeness, clarity"],
				["adversarial", "Edge cases, failure modes, unstated assumptions"],
				["security", "Injection, auth, secrets, path traversal, SSRF"],
			],
		},
	],

	capabilities: [
		"Configurable gate policy — majority, strict, or unanimous",
		"Per-project rubric — override the default rubric via .onlooker/rubrics/",
		"Meta-Judge bias detection — catches jury hallucination and criteria misapplication before the gate",
		"Retry with critique — Actor receives structured feedback; doesn't start from scratch",
		"Full event stream — tribunal.* events cover every step for audit and replay",
		"Grounded in research — Zheng et al. (2023) LLM-as-a-Judge; Wu et al. (2024) LLM-as-a-Meta-Judge",
	],

	events: [
		{
			type: "tribunal.actor.complete",
			when: "Actor finishes a pass",
			keyFields: "iteration, output_summary",
		},
		{
			type: "tribunal.judge.verdict",
			when: "Each judge submits a verdict",
			keyFields: "judge_type, score, rationale",
		},
		{
			type: "tribunal.meta.complete",
			when: "Meta-Judge finishes bias review",
			keyFields: "verdict_quality, bias_detected, bias_types",
		},
		{
			type: "tribunal.gate.decision",
			when: "Gate evaluates verdicts under policy",
			keyFields: "decision, policy, iteration, scores",
		},
	],

	config: `{
  "tribunal": {
    "enabled": true,
    "gate_policy": "majority",
    "judge_types": ["standard", "adversarial"],
    "max_iterations": 3
  }
}`,

	tags: [
		"quality",
		"evaluation",
		"judges",
		"multi-agent",
		"LLM-as-a-Judge",
		"review",
		"rubric",
		"retry",
	],
};
