import type { PluginProse } from "./types";

export const governor: PluginProse = {
	slug: "governor",
	name: "Governor",
	tagline: "Your agent has a budget. Enforce it.",
	category: "governance",
	problem:
		"A misconfigured orchestration loop or an overly ambitious agent can burn through a token budget in minutes. Automated pipelines don't notice until the bill arrives. Manual budget checks don't scale.",
	howItWorks: [
		"Estimate — before each Task spawn, Governor estimates the token cost using a tier-table method",
		"Check — reads the session ledger to compute total tokens consumed + in-flight reservations",
		"Gate — if consumed + estimated exceeds the budget, the Task is blocked",
		"Record — on completion, actual token counts update the ledger",
	],
};
