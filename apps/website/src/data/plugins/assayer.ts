import type { PluginProse } from "./types";

export const assayer: PluginProse = {
	slug: "assayer",
	name: "Assayer",
	tagline: "Does the agent's story match the session's receipts?",
	category: "quality",
	problem:
		'An agent finishes and tells you what it did: "I ran the tests, they pass," "the build is green," "lint is clean." Sometimes that\'s true. Sometimes it ran the tests, then made a fix, then never re-ran. Sometimes it never ran them at all. Without a check, a confident final message and a green-light Stop look identical whether the agent verified its work or hallucinated the verification. There\'s no malice — just an honest mismatch between the story and the receipts.',
	howItWorks: [
		"Stop — reads the just-finished session's transcript at transcript_path; extracts the final assistant message and every Bash command paired with its is_error result",
		"Claim extractor (LLM) — a single claude -p pass identifies success claims in the final message, tagging each with a type (tests_pass, build_succeeds, lint_clean, types_check, command_succeeds, generic) and a command_keyword",
		"Verifier (deterministic bash) — for each claim, finds the most recent command matching the keyword and reads its is_error; the LLM never judges truth, only what would settle the claim",
		"Verdict — corroborated (matching command ran and succeeded), contradicted (matching command ran and failed), or unverified (no matching command, or claim implies no checkable command)",
	],
};
