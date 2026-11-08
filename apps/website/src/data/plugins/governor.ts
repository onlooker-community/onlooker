import type { PluginProse } from "./types";

export const governor: PluginProse = {
	slug: "governor",
	name: "Governor",
	tagline: "Keeps subagent fan-out inside a spend envelope.",
	category: "governance",
	problem:
		"Subagent fan-out can accelerate unchecked. A loop that keeps spawning Task calls spends tokens whether or not anyone is watching, and nothing in the session says so until it is over. Governor tracks the session's spend and checks each spawn against a budget before it runs.",
	howItWorks: [
		"On PreToolUse for Task, Governor estimates the spawn's tokens, adds them to what the session has already consumed, and compares the projection against the budget. It writes a reservation first, so concurrent spawns see each other's in-flight cost.",
		"Soft enforcement records a budget overrun and lets the spawn run. Hard enforcement blocks it. A projection past the hard ceiling is blocked in both modes.",
		"On PostToolUse for Task, it cancels the reservation and records the observed token usage when the response reports it, so the running total converges on real spend.",
		"On Stop, it emits governor.session.complete with the session's totals and whether it stayed under budget. Bursar reads that event for its cross-session rollup.",
	],
};
