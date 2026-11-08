import type { PluginProse } from "./types";

export const assayer: PluginProse = {
	slug: "assayer",
	name: "Assayer",
	tagline: "Does the agent's story match the session's receipts?",
	category: "quality",
	problem:
		'An agent finishes and tells you what it did: "I ran the tests, they pass," "the build is green," "lint is clean." Sometimes it ran the tests, then made a fix and never re-ran them. Sometimes it assumed. A confident final message reads the same either way. There is no malice in it, just a story that has drifted from the receipts.',
	howItWorks: [
		"On Stop, Assayer reads the finished session's transcript: the agent's final message, and every Bash command paired with whether it errored.",
		"A single claude -p pass pulls the testable success claims out of the final message and names the command that would settle each one. The model identifies claims; it does not judge them.",
		"A deterministic verifier checks each claim against the most recent matching command and its is_error flag, so the same inputs always give the same verdict.",
		"Each claim comes out corroborated, contradicted or unverified. Assayer is advisory: it always exits 0 and never blocks Stop.",
	],
};
