import type { PluginData } from "./types";

export const curator: PluginData = {
	slug: "curator",
	name: "Curator",
	version: "0.1.0",
	tagline: "Tends the memory garden.",
	category: "memory",

	hero: {
		headline: "Your typed memory store drifts. Curator notices.",
		subheadline:
			"At every session start, Curator runs cheap heuristic checks against your auto-memory store — flagging decayed dates, broken path references, broken index entries, and orphaned files — and surfaces a one-line pointer to /curator review. It never edits the store directly; you decide what to prune.",
	},

	problem:
		'A typed memory store accumulates. A project memory says "merge freeze begins 2026-03-05" — the date passes and the rule keeps firing. A reference memory points at scripts/legacy_ingest.py — the file gets deleted and the pointer dangles. MEMORY.md grows entries that no longer have files behind them; the memory dir grows files no one indexes. None of these are individually catastrophic; together they erode the signal-to-noise of every session that consults memory.',

	howItWorks: [
		"SessionStart — runs the cheap-tier audit against ~/.claude/projects/<encoded-project>/memory/, inside a 500ms wall-clock budget; skips if the session is younger than 5 seconds (avoids storm on rapid restarts)",
		"Reads MEMORY.md and the referenced memory files; parses frontmatter (name, description, type) and the body of each",
		"Date check — scans bodies for ISO-8601 dates; flags any more than date_grace_period_days (default: 14) in the past",
		"Reference check — extracts path-shaped tokens, resolves against the repo root, flags paths that no longer exist",
		"Index integrity — files referenced from MEMORY.md but missing on disk become broken_index findings; files on disk not referenced from MEMORY.md become orphaned_memory findings",
		"Writes new findings to ~/.onlooker/curator/<project-key>/findings/<ulid>.json, deduped via a stable finding hash so the same finding isn't re-emitted every session",
		"Injects a one-line additionalContext pointer when open findings exist — full details live behind /curator review (deferred to a follow-up landing)",
	],

	tables: [
		{
			title: "Cheap-tier checks (ship today)",
			headers: ["Check", "What it catches"],
			rows: [
				[
					"date_decayed",
					"ISO-8601 date in a memory body that has passed the grace period and may no longer apply",
				],
				[
					"path_broken",
					"Path reference in a memory body that no longer resolves against the repo root",
				],
				["broken_index", "MEMORY.md links a file that does not exist on disk"],
				[
					"orphaned_memory",
					"A *.md file in the memory dir that no MEMORY.md entry points to",
				],
			],
		},
		{
			title: "Deferred to follow-up landings",
			headers: ["Capability", "Why deferred"],
			rows: [
				[
					"LLM contradiction sweep",
					"Watermark plumbing is in place; the Haiku pair-evaluation loop is not implemented yet",
				],
				[
					"Usage tracker",
					"Depends on a substrate-level memory.recalled emitter that does not exist yet",
				],
				[
					"Symbol reference check",
					"Backtick-wrapped identifiers grep'd against the repo — not yet wired",
				],
				[
					"/curator review walkthrough",
					"Accept / prune / edit / reclassify / acknowledge / defer for surfaced findings",
				],
			],
		},
	],

	capabilities: [
		"Audit-only posture — Curator never edits memory files; it surfaces findings and lets the human decide (same shape as cartographer and librarian)",
		"Wall-clock budgeted — cheap-tier checks cap at 500ms; over-budget runs emit curator.scan.skipped rather than slow the session start",
		"Deduped findings — repeat findings are collapsed via a stable hash so the same broken path doesn't pile up across sessions",
		"Per-project scoping — each project gets its own findings store under ~/.onlooker/curator/<project-key>/",
		"Disabled by default — opt-in via curator.enabled: true, like compass and warden",
		"Parallel to cartographer — same audit/propose/surface shape; cartographer covers hand-maintained instruction files, curator covers the typed auto-memory store",
	],

	events: [
		{
			type: "curator.finding.date_decayed",
			when: "A memory body contains a date past the grace period",
			keyFields: "memory_file, matched_phrase, gap_days",
		},
		{
			type: "curator.finding.path_broken",
			when: "A memory body references a path that no longer exists",
			keyFields: "memory_file, broken_path",
		},
		{
			type: "curator.finding.broken_index",
			when: "MEMORY.md links a file that is not on disk",
			keyFields: "memory_file, index_entry",
		},
		{
			type: "curator.finding.orphaned_memory",
			when: "A memory file on disk is not referenced from MEMORY.md",
			keyFields: "memory_file",
		},
		{
			type: "curator.scan.skipped",
			when: "The cheap-tier scan was skipped — over budget, recently run, or no memories",
			keyFields: "reason",
		},
	],

	config: `{
  "curator": {
    "enabled": false,
    "cheap_checks": {
      "enabled": true,
      "wall_clock_budget_ms": 500,
      "skip_if_session_age_under_seconds": 5
    },
    "date_check": {
      "enabled": true,
      "date_grace_period_days": 14
    },
    "reference_check": {
      "enabled": true,
      "check_urls": false
    },
    "surfacer": {
      "max_pointer_chars": 200,
      "skip_when_zero": true
    }
  }
}`,

	tags: [
		"memory",
		"maintenance",
		"audit",
		"auto-memory",
		"drift",
		"stale-references",
		"session-start",
	],

	skillCommands: `/curator review   # walk through open findings (deferred to follow-up)
/curator scan     # force a full sweep, ignoring rate gates (deferred to follow-up)`,

	idealFor:
		"Anyone who relies on Claude Code's typed auto-memory store and has watched it accumulate stale dates or dangling paths over weeks of work; teams using librarian to promote memories and wanting an audit signal on what those promotions look like over time; projects parallel-running cartographer who want the same audit shape for the auto-memory substrate.",
};
