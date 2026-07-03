import type { PluginData } from "./types";

export const compass: PluginData = {
	slug: "compass",
	name: "Compass",
	version: "0.1.0",
	tagline: "Writes with intent.",
	category: "safety",

	hero: {
		headline: "Block ambiguous writes before they land.",
		subheadline:
			"Compass intercepts every write-class operation and requires confidence before proceeding — because one clarifying prompt is cheaper than a revert.",
	},

	problem:
		'The most expensive agent mistakes aren\'t wrong code. They\'re the wrong write, to the wrong file, based on an ambiguous instruction. "Refactor the auth module" becomes a rewrite of everything authentication-adjacent. "Just delete it" runs on the wrong target. By the time you notice, six files have been touched.',

	howItWorks: [
		"Read context — retrieves the prior assistant turn so the evaluation isn't blind to what was just asked",
		"Symbolic skip — if you answered an agent's enumerated question, skip straight to allow (no API call)",
		"Sample 5 evaluators — independent Haiku calls score intent clarity at temperature 0.3",
		"Aggregate — compute mean confidence and standard deviation across samples",
		"Gate — allow if confidence ≥ 0.65 AND stddev ≤ 0.20; otherwise surface a clarification prompt",
	],

	capabilities: [
		"Dual-signal block — low confidence OR high evaluator disagreement both trigger",
		"Context-aware — evaluates the {prior turn, current context} pair, not context alone",
		"Symbolic skip layer — zero API cost for the most common conversational pattern (agent asks → user answers)",
		"Dir+stem cooldown — same file doesn't get re-checked within 120 seconds",
		"Turn budget — max 3 checks per agent turn, then passes through",
		"Circuit breaker — opens after 3 consecutive evaluator failures; fails-open for 5 min",
		"Three resolution paths — proceed, clarify + re-check, or cancel",
	],

	config: `{
  "compass": {
    "enabled": true,
    "confidence_threshold": 0.65,
    "stddev_threshold": 0.20,
    "cooldown": { "seconds": 120 }
  }
}`,

	tags: [
		"safety",
		"intent",
		"alignment",
		"pre-write",
		"gate",
		"ambiguity",
		"clarification",
	],

	interventionExample: `Compass blocked this write — low confidence (0.58 < 0.65).

File: src/auth/session.ts · Tool: Edit · Concern: scope
Evaluator rationale: "Target file unclear — auth module has multiple session files"

• Type compass: proceed — override and allow
• Provide more context — compass will re-evaluate once
• Type compass: cancel — abandon this write`,
};
