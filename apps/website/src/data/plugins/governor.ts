import type { PluginData } from "./types";

export const governor: PluginData = {
	slug: "governor",
	name: "Governor",
	version: "0.2.0",
	tagline: "Your agent has a budget. Enforce it.",
	category: "governance",

	hero: {
		headline: "Stop runaway Task spawns before they drain your budget.",
		subheadline:
			"Governor tracks per-session token and cost spend, estimates the cost of each Task spawn before it runs, and blocks it when the projected total would exceed your ceiling.",
	},

	problem:
		"A misconfigured orchestration loop or an overly ambitious agent can burn through a token budget in minutes. Automated pipelines don't notice until the bill arrives. Manual budget checks don't scale.",

	howItWorks: [
		"Estimate — before each Task spawn, Governor estimates the token cost using a tier-table method",
		"Check — reads the session ledger to compute total tokens consumed + in-flight reservations",
		"Gate — if consumed + estimated exceeds the budget, the Task is blocked",
		"Record — on completion, actual token counts update the ledger",
		"Emit — every gate decision is logged as a governor.gate.checked event",
	],

	tables: [
		{
			title: "Enforcement modes",
			headers: ["Mode", "Behavior"],
			rows: [
				[
					"soft",
					"Always allows; emits event with decision and projected spend",
				],
				[
					"hard",
					"Blocks when budget is exceeded; hard-stop ceiling always enforced",
				],
			],
		},
	],

	capabilities: [
		"Per-session budget tracking — tokens and cost tracked independently",
		"Atomic gate — concurrent spawns can't race past the limit",
		"Soft and hard enforcement — soft mode logs and warns; hard mode blocks",
		"Hard-stop ceiling — unconditional block at budget × 1.5, regardless of enforcement mode",
		"Safety margin — configurable multiplier (default 1.3×) on estimates before comparing to budget",
		"Event log integration — every decision emits to the shared JSONL log for audit",
	],

	events: [
		{
			type: "governor.gate.checked",
			when: "Every Task spawn attempt",
			keyFields:
				"decision, consumed_tokens, estimated_tokens, budget_tokens, enforcement",
		},
	],

	config: `{
  "governor": {
    "enabled": true,
    "enforcement": "hard",
    "session": {
      "tokens_default": 100000,
      "cost_usd_default": 1.00
    }
  }
}`,

	tags: [
		"budget",
		"tokens",
		"cost",
		"governance",
		"safety",
		"limits",
		"subagents",
		"Task",
	],
};
