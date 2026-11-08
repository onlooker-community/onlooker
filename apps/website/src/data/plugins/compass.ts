import type { PluginProse } from "./types";

export const compass: PluginProse = {
	slug: "compass",
	name: "Compass",
	tagline: "Writes with intent.",
	category: "safety",
	problem:
		'The most expensive agent mistakes aren\'t wrong code. They\'re the wrong write, to the wrong file, based on an ambiguous instruction. "Refactor the auth module" becomes a rewrite of everything authentication-adjacent. "Just delete it" runs on the wrong target. By the time you notice, six files have been touched.',
	howItWorks: [
		"Read context — retrieves the prior assistant turn so the evaluation isn't blind to what was just asked",
		"Symbolic skip — if you answered an agent's enumerated question, skip straight to allow (no API call)",
		"Sample 5 evaluators — independent Haiku calls score intent clarity at temperature 0.3",
		"Aggregate — compute mean confidence and standard deviation across samples",
	],
};
