import type { PluginProse } from "./types";

export const compass: PluginProse = {
	slug: "compass",
	name: "Compass",
	tagline: "Writes with intent.",
	category: "safety",
	problem:
		'The most expensive agent mistakes are not wrong code. They are the wrong write, to the wrong file, from an ambiguous instruction. "Refactor the auth module" becomes a rewrite of everything authentication-adjacent. "Just delete it" runs on the wrong target. Compass checks that the intent was clear before the write happens.',
	howItWorks: [
		"On PreToolUse for Write, Edit and MultiEdit, Compass evaluates the pending write. For Bash it first matches the command against write patterns (redirects, rm, mv, cp, tee) and does nothing when none match.",
		"It reads the prior assistant turn from the transcript, so a terse reply to a question the agent just asked is not mistaken for a vague instruction. A reply that cleanly picks one of the options skips the model call.",
		"Otherwise a panel of parallel evaluators asks whether two independent readers would converge on the same interpretation of the write.",
		"The write is blocked when confidence is low or the evaluators disagree with each other. A blocked write offers three ways out: compass: proceed to override, more context for a re-check, or compass: cancel.",
	],
};
