import type { PluginData } from "./types";

export const librarian: PluginData = {
	slug: "librarian",
	name: "Librarian",
	version: "0.1.0",
	tagline: "Promotes what's worth keeping.",
	category: "memory",

	hero: {
		headline:
			"The same decision, rediscovered every session. Librarian ends it.",
		subheadline:
			"Librarian reads archivist's session artifacts, filters for durability, classifies surviving candidates into your four memory types, detects conflicts and duplicates against existing entries, and queues proposals for explicit confirmation. By default it never writes to the typed memory store directly — you accept each promotion.",
	},

	problem:
		'A user explains why the auth middleware is being rewritten — legal compliance, not tech debt. Archivist captures it as a decision; recency re-injects it for a few sessions; eventually it ages out, and the agent asks "why are we rewriting this?" all over again. The typed memory store could have absorbed the fact, but only if the user thought to say "remember that." Most don\'t. The store stays starved, archivist re-captures the same facts every session, and the agent re-asks the same questions.',

	howItWorks: [
		"SessionEnd — scans archivist artifacts (decisions, dead_ends, open_questions) created since the last librarian watermark, bootstrapping over bootstrap_lookback_days (default: 14) on first run",
		'Durability filter — cheap pre-LLM pass keeps candidates that show signs of lasting: marker phrases ("always", "never", "the reason"), path grounding, repetition across ≥2 sessions; drops short-detail noise',
		'Type classifier — single Haiku call per candidate emits one of user/feedback/project/reference (or null for "session-only — don\'t promote"); confidence floor of 0.6 drops the noisy tail',
		"Conflict + duplicate detector — Jaccard similarity against existing memory files; classifies each candidate as none / duplicate / merge_candidate / conflict_candidate (cheap pattern matching, not an LLM call — curator handles deep contradictions)",
		"Proposal queue — surviving candidates land in ~/.onlooker/librarian/<project-key>/proposals/<ulid>.json with conflict state and source provenance",
		"SessionStart — counts pending proposals; injects a single short pointer to /librarian review if any",
		'Accepted promotions land in the typed memory store with a source: "librarian" provenance trailer — so curator can later trace any promoted memory back to the originating session',
	],

	tables: [
		{
			title: "Memory types Librarian classifies into",
			headers: ["Type", "What it promotes"],
			rows: [
				[
					"user",
					"Durable facts about the user's role, expertise, or working style",
				],
				[
					"feedback",
					'Corrections or validated preferences ("don\'t do X", "yes, keep doing Y") — includes Why and How to apply lines',
				],
				[
					"project",
					"Ongoing work facts, decisions, constraints not derivable from the code — includes Why and How to apply lines",
				],
				[
					"reference",
					"Pointers to external systems (issue trackers, dashboards, channels)",
				],
				[
					"null",
					"Session-only — interesting but not durable; classifier opted out of promotion",
				],
			],
		},
		{
			title: "Conflict states surfaced for each proposal",
			headers: ["State", "What it means"],
			rows: [
				["none", "No similar existing memory — accept cleanly or reject"],
				[
					"duplicate",
					"Very high similarity to an existing memory — dropped silently as redundant",
				],
				[
					"merge_candidate",
					'Partial overlap — surfacer offers "merge into existing memory X"',
				],
				[
					"conflict_candidate",
					'Opposing sentiment markers vs. existing memory — surfacer offers "supersede / keep both / drop new"',
				],
			],
		},
		{
			title: "Status",
			headers: ["Component", "State"],
			rows: [
				[
					"Hook entry points + scaffolding",
					"Ships now — load cleanly, archivist artifact paths wired",
				],
				[
					"Scan + classify + propose pipeline",
					"In design / scaffolding phase — not yet implemented",
				],
				[
					"/librarian review interactive walkthrough",
					"Deferred — accept / reject / edit / merge / supersede per proposal",
				],
				[
					"Auto-promote at high confidence",
					"Off by default — ADR-001 commits to propose-don't-auto-write",
				],
			],
		},
	],

	capabilities: [
		"Propose-only by default — ADR-001 commits to never writing to the typed memory store without explicit user confirmation; auto-promote is off and gated behind a separate confidence threshold",
		"Provenance-preserving — accepted promotions carry source, source_session_id, source_artifact_ids, classifier_confidence, and promoted_at in their frontmatter so the trail is auditable",
		"Conflict-aware — Jaccard duplicate / merge / conflict detection runs locally before any proposal reaches the user; the queue stays high-signal",
		"Watermark-incremental — only scans artifacts created since the last run; bootstrap_lookback_days covers the first run",
		"Tombstone tracking — rejected and pruned promotions are tombstoned for ttl_days (default: 180) so the same candidate doesn't re-propose itself",
		"Disabled by default — opt-in via librarian.enabled: true; degrades to no-op if archivist is not installed",
		"Sibling to curator — librarian writes (with confirmation); curator audits what was written. Sibling to historian — librarian distills, historian preserves verbatim.",
	],

	events: [
		{
			type: "librarian.scan.complete",
			when: "A SessionEnd scan finished — proposals written or empty",
			keyFields: "artifacts_scanned, candidates_kept, proposals_written",
		},
		{
			type: "librarian.scan.empty",
			when: "The durability filter dropped every candidate — nothing to propose",
			keyFields: "artifacts_scanned, reason",
		},
		{
			type: "librarian.candidate.dropped",
			when: "A candidate was dropped after classification or conflict detection",
			keyFields: "reason (duplicate / low_confidence / classifier_null)",
		},
		{
			type: "librarian.proposal.created",
			when: "A surviving candidate is queued for user review",
			keyFields:
				"proposal_id, proposed_type, conflict_state, classifier_confidence",
		},
	],

	config: `{
  "librarian": {
    "enabled": false,
    "auto_promote": false,
    "auto_promote_threshold": 0.85,
    "scan": {
      "trigger": "SessionEnd",
      "bootstrap_lookback_days": 14,
      "min_detail_chars": 40
    },
    "classifier": {
      "model": "claude-haiku-4-5-20251001",
      "temperature": 0.2,
      "max_output_tokens": 256,
      "min_classifier_confidence": 0.6
    },
    "conflict": {
      "duplicate_threshold": 0.7,
      "merge_candidate_threshold": 0.45,
      "conflict_keyword_overlap": 0.5
    },
    "tombstones": {
      "ttl_days": 180
    }
  }
}`,

	tags: [
		"memory",
		"promotion",
		"classification",
		"auto-memory",
		"archivist",
		"durability",
		"session-end",
	],

	skillCommands: `/librarian review   # walk through pending proposals — accept / reject / edit / merge (deferred)
/librarian calibrate # tune the durability filter against your repo (deferred)`,

	idealFor:
		'Teams running archivist who want session-scoped artifacts to graduate into durable memory without manual "remember that" prompts; users whose typed memory store stays near-empty despite months of work; projects where load-bearing project facts and validated feedback should survive recency budgets — but where silent auto-writes to the memory store are unacceptable.',
};
