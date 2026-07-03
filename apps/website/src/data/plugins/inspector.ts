import type { PluginData } from "./types";

export const inspector: PluginData = {
	slug: "inspector",
	name: "Inspector",
	version: "0.1.0",
	tagline: "Per-edit lint and typecheck, so the agent sees its own errors.",
	category: "quality",

	hero: {
		headline:
			"After every Write, Edit, MultiEdit — does the code actually compile?",
		subheadline:
			"Inspector runs the project's configured lint and typecheck commands on just the touched file at PostToolUse, then surfaces the results back to the agent on its next turn. A fast feedback loop that gives the agent accurate ground truth about what it just wrote — before it claims success.",
	},

	problem:
		"The ecosystem already judges agent output after the fact and gates ambiguous writes before they happen. What it didn't have is the loop in between: a fast check that runs after every edit and tells the agent whether the code it just wrote actually compiles. Without that signal, the agent's next turn is built on stale ground truth — it assumes its last edit was correct because nothing told it otherwise, then layers more changes on top, and the broken file isn't discovered until Stop (or after the agent declares success).",

	howItWorks: [
		"PostToolUse on Edit / Write / MultiEdit — resolves the touched file from tool_input.file_path; looks up the configured checks for the file's extension",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal hook placeholder syntax in documentation string
		"Per-check execution — runs each check with a per-check timeout (default: 10s) and a total budget (default: 30s); ${file} / ${file_relative} / ${repo_root} placeholders expand before exec",
		"Output capture — captures stdout/stderr up to output_excerpt_max_bytes (default: 4096) and emits inspector.check.passed / .failed / .skipped per check, plus an inspector.run.completed summary",
		"Agent-facing summary — the hook's stdout (additional-context for PostToolUse) prints failed checks with line/column issues by default; show_clean_runs: true also surfaces passing checks",
		"Bounded and advisory — total_timeout_seconds caps the whole run; remaining checks emit .skipped with reason: total_budget_exhausted; the hook always exits 0 so it never blocks a tool call",
		"Path-aware exclusions — files in node_modules, dist, vendor, .venv, etc. emit .skipped with reason: excluded_path and run no checks",
	],

	tables: [
		{
			title: "What Inspector is — and isn't",
			headers: ["Plugin", "Where it runs"],
			rows: [
				[
					"Inspector",
					"PostToolUse on Edit / Write / MultiEdit — per touched file, cheap, fires often",
				],
				["Proctor (planned)", "Stop — full project verification command"],
				[
					"Assayer",
					"Stop — checks the agent's claims against transcript evidence; needs Inspector's real signals to work against",
				],
				[
					"Build system",
					"Not Inspector's job — no cross-file caching, no dependency graphs",
				],
			],
		},
		{
			title: "Skipped check reasons",
			headers: ["Reason", "Meaning"],
			rows: [
				["disabled", "inspector.enabled is false"],
				["excluded_path", "File is under an exclude_paths segment"],
				["no_extension_match", "No checks configured for this file extension"],
				["not_in_repo", "File is outside the current git repo"],
				["tool_missing", "The configured tool is not on PATH"],
				["timeout", "Check exceeded timeout_seconds_per_check"],
				[
					"total_budget_exhausted",
					"Run exceeded total_timeout_seconds; remaining checks did not run",
				],
			],
		},
	],

	capabilities: [
		"Per-file scope by default — most checks (biome, ruff, shellcheck) run on the single touched file and finish in milliseconds",
		"Project-scoped checks supported — tsc / mypy / cargo check have no meaningful single-file form; Inspector runs the full project check and relies on each tool's incremental cache to keep latency manageable",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal hook placeholder syntax in documentation string
		"Argv-as-config — each check is { name, kind, argv }; the literal argv array is what gets executed, with ${file} / ${file_relative} / ${repo_root} placeholders",
		"Bash 3.2+ compatible — works on the macOS system bash with no mapfile / readarray / associative arrays",
		"Advisory always — missing tools, timeouts, hook errors all skip rather than block; Inspector never gets in the way of an edit",
		"Composes with Assayer — Inspector emits real pass/fail signals; Assayer later confirms the agent's final-message claims line up with those signals",
		"Disabled by default — opt-in via inspector.enabled: true and a checks map per extension",
	],

	events: [
		{
			type: "inspector.check.passed",
			when: "A check returned exit 0",
			keyFields:
				"file_path, tool_name, check_name, check_kind, argv, duration_ms",
		},
		{
			type: "inspector.check.failed",
			when: "A check returned non-zero",
			keyFields: "exit_code, issue_count, output_excerpt, output_truncated",
		},
		{
			type: "inspector.check.skipped",
			when: "A check or whole file was not run",
			keyFields:
				"reason (disabled | excluded_path | no_extension_match | not_in_repo | tool_missing | timeout | total_budget_exhausted)",
		},
		{
			type: "inspector.run.completed",
			when: "Once per hook fire after all checks",
			keyFields:
				"checks_run, checks_passed, checks_failed, checks_skipped, duration_ms",
		},
	],

	config: `{
  "inspector": {
    "enabled": false,
    "timeout_seconds_per_check": 10,
    "total_timeout_seconds": 30,
    "output_excerpt_max_bytes": 4096,
    "show_clean_runs": false,
    "exclude_paths": [
      "node_modules", ".git", "vendor", ".venv", "dist",
      ".next", ".nuxt", "build", "__pycache__", "target", "coverage"
    ],
    "checks": {
      ".ts":  [{ "name": "biome", "kind": "lint",      "argv": ["biome", "check", "\${file}"] },
               { "name": "tsc",   "kind": "typecheck", "argv": ["tsc", "--noEmit"] }],
      ".py":  [{ "name": "ruff",       "kind": "lint", "argv": ["ruff", "check", "\${file}"] }],
      ".sh":  [{ "name": "shellcheck", "kind": "lint", "argv": ["shellcheck", "\${file}"] }]
    }
  }
}`,

	tags: [
		"quality",
		"lint",
		"typecheck",
		"post-tool-use",
		"feedback-loop",
		"advisory",
		"per-edit",
	],

	idealFor:
		"Repos with established linters and typecheckers that the agent should be respecting in real time; anyone tired of discovering a TypeScript error at Stop that the agent could have fixed five turns earlier; teams running Assayer who want Inspector's per-edit signals as the ground truth Assayer checks final-message claims against.",
};
