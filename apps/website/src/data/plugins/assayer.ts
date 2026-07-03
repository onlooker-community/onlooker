import type { PluginData } from "./types";

export const assayer: PluginData = {
	slug: "assayer",
	name: "Assayer",
	version: "0.1.0",
	tagline: "Does the agent's story match the session's receipts?",
	category: "quality",

	hero: {
		headline: "The agent said tests pass. Assayer checks the transcript.",
		subheadline:
			"At Stop, Assayer extracts the agent's testable success claims from its final message, cross-checks each against the actual Bash commands that ran in the same session, and emits a verdict per claim — catching lying-without-malice when the agent misremembered, assumed, or never re-ran after a change.",
	},

	problem:
		'An agent finishes and tells you what it did: "I ran the tests, they pass," "the build is green," "lint is clean." Sometimes that\'s true. Sometimes it ran the tests, then made a fix, then never re-ran. Sometimes it never ran them at all. Without a check, a confident final message and a green-light Stop look identical whether the agent verified its work or hallucinated the verification. There\'s no malice — just an honest mismatch between the story and the receipts.',

	howItWorks: [
		"Stop — reads the just-finished session's transcript at transcript_path; extracts the final assistant message and every Bash command paired with its is_error result",
		"Claim extractor (LLM) — a single claude -p pass identifies success claims in the final message, tagging each with a type (tests_pass, build_succeeds, lint_clean, types_check, command_succeeds, generic) and a command_keyword",
		"Verifier (deterministic bash) — for each claim, finds the most recent command matching the keyword and reads its is_error; the LLM never judges truth, only what would settle the claim",
		"Verdict — corroborated (matching command ran and succeeded), contradicted (matching command ran and failed), or unverified (no matching command, or claim implies no checkable command)",
		"Most-recent-wins — an agent may fail, fix, and re-run; the last matching run reflects the state the final message describes",
		"Emits assayer.audit.started, per-claim assayer.claim.contradicted and assayer.claim.unverified, and an assayer.audit.complete summary — corroborated claims roll into the summary so the happy path stays quiet",
		"Always exits 0 — advisory only, never blocks Stop",
	],

	tables: [
		{
			title: "Verdicts",
			headers: ["Verdict", "Meaning"],
			rows: [
				["corroborated", "A matching command ran and succeeded"],
				[
					"contradicted",
					"A matching command ran and failed — the claim is not backed by the evidence",
				],
				[
					"unverified",
					"No matching command (no_matching_command), or the claim implies no checkable command (ambiguous)",
				],
			],
		},
		{
			title: "Claim types the extractor recognizes",
			headers: ["Type", "Example phrasing"],
			rows: [
				["tests_pass", '"All tests pass," "the suite is green"'],
				["build_succeeds", '"The build is clean," "compiles without errors"'],
				["lint_clean", '"No lint issues," "biome is happy"'],
				["types_check", '"tsc passes," "no type errors"'],
				["command_succeeds", '"I ran <X> and it succeeded"'],
				[
					"generic",
					"Catch-all for verifiable success claims that do not fit the above",
				],
			],
		},
	],

	capabilities: [
		"is_error, not exit codes — Claude Code records tool_use blocks and tool_result blocks carrying an is_error flag; there is no per-call numeric exit code, so is_error is the success/failure signal",
		"Two-half pipeline — the LLM identifies claims and what would settle them; the deterministic verifier reads transcript facts. Same inputs always produce the same verdict",
		"Advisory only — Assayer always exits 0; it surfaces contradictions in events and audit summaries rather than blocking Stop",
		"Composes with Inspector — Inspector ensures the agent has accurate ground truth (real pass/fail signals); Assayer confirms the agent's claims line up with that truth",
		"Cheap and structured — uses Haiku for extraction by default; the task is shallow and the model never has to decide whether a claim is true",
		"Per-project audit log — one audit-<session-id>.json under ~/.onlooker/assayer/<project-key>/ records claim tallies, the overall verdict, and the per-claim list",
		"Disabled by default — opt-in via assayer.enabled: true since every Stop pays a claude -p call",
	],

	events: [
		{
			type: "assayer.audit.started",
			when: "Before verification begins",
			keyFields: "claim_count, command_count",
		},
		{
			type: "assayer.claim.contradicted",
			when: "A claim is contradicted by a failing command",
			keyFields: "claim, evidence_command, result_excerpt",
		},
		{
			type: "assayer.claim.unverified",
			when: "A claim has no supporting evidence",
			keyFields: "reason (no_matching_command | ambiguous)",
		},
		{
			type: "assayer.audit.complete",
			when: "After all claims are checked",
			keyFields:
				"tallies, verdict (clean | contradictions_found | nothing_to_verify), duration_ms",
		},
	],

	config: `{
  "assayer": {
    "enabled": false,
    "evaluation": {
      "model": "claude-haiku-4-5-20251001",
      "timeout_seconds": 60
    },
    "max_claims": 12,
    "min_confidence": 0.5,
    "final_message_chars": 6000
  }
}`,

	tags: [
		"quality",
		"claim-verification",
		"transcript",
		"audit",
		"hallucination",
		"stop-hook",
		"advisory",
	],

	idealFor:
		'Teams that have watched an agent confidently announce "all tests pass" only to discover the suite never ran since the last fix; anyone running long autonomous sessions where the final message is the only signal a human will read; projects already running Inspector for per-edit lint and typecheck signals — Assayer closes the loop by confirming the agent\'s summary matches those signals.',
};
