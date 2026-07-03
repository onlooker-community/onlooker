import type { PluginData } from "./types";

export const echo: PluginData = {
	slug: "echo",
	name: "Echo",
	version: "0.2.0",
	tagline: "Test your prompts, not just your code.",
	category: "testing",

	hero: {
		headline: "You changed the agent. Did it get better or worse?",
		subheadline:
			"Echo runs a judge pass against a stored baseline every time a watched agent file changes — so you know immediately whether the edit improved, degraded, or had no effect.",
	},

	problem:
		"You improve an agent's AGENTS.md, push it, and notice three sessions later that behavior has shifted. The diff looked clean. No tests failed. But prompt regressions are invisible to standard CI — because nobody tested the prompt.",

	howItWorks: [
		"Watch — Echo monitors your agent files (plugins/*/agents/*.md by default, configurable)",
		"Detect — when a watched file changes (PostToolUse), Echo checks if a baseline exists",
		"Evaluate — runs a single-judge quality pass via claude -p against the changed file",
		"Compare — scores the result against the stored baseline",
		"Report — emits echo.improvement.detected, echo.regression.detected, or neutral",
	],

	capabilities: [
		"Automatic on file change — no manual step required",
		"Configurable watch paths — watch any agent or prompt file pattern",
		"Drift threshold — only flag changes above a configurable score delta (default: 0.05)",
		"Recursion guard — never triggers on its own config files",
		"Event log integration — all results emit to the Onlooker event log",
	],

	events: [
		{
			type: "echo.improvement.detected",
			when: "Evaluated score exceeds baseline by more than drift_threshold",
			keyFields: "file, prior_score, new_score, delta",
		},
		{
			type: "echo.regression.detected",
			when: "Evaluated score falls below baseline by more than drift_threshold",
			keyFields: "file, prior_score, new_score, delta",
		},
	],

	config: `{
  "echo": {
    "enabled": true,
    "drift_threshold": 0.05,
    "watch_paths": [
      "plugins/*/agents/*.md",
      "agents/**/*.md"
    ]
  }
}`,

	tags: [
		"testing",
		"regression",
		"prompts",
		"agents",
		"quality",
		"evaluation",
		"baseline",
	],
};
