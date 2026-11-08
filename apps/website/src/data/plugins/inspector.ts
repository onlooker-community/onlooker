import type { PluginProse } from "./types";

export const inspector: PluginProse = {
	slug: "inspector",
	name: "Inspector",
	tagline: "Per-edit lint and typecheck, so the agent sees its own errors.",
	category: "quality",
	problem:
		"The ecosystem already judges agent output after the fact and gates ambiguous writes before they happen. What it didn't have is the loop in between: a fast check that runs after every edit and tells the agent whether the code it just wrote actually compiles. Without that signal, the agent's next turn is built on stale ground truth — it assumes its last edit was correct because nothing told it otherwise, then layers more changes on top, and the broken file isn't discovered until Stop (or after the agent declares success).",
	howItWorks: [
		"PostToolUse on Edit / Write / MultiEdit — resolves the touched file from tool_input.file_path; looks up the configured checks for the file's extension",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal hook placeholder syntax in documentation string
		"Per-check execution — runs each check with a per-check timeout (default: 10s) and a total budget (default: 30s); ${file} / ${file_relative} / ${repo_root} placeholders expand before exec",
		"Output capture — captures stdout/stderr up to output_excerpt_max_bytes (default: 4096) and emits inspector.check.passed / .failed / .skipped per check, plus an inspector.run.completed summary",
		"Agent-facing summary — the hook's stdout (additional-context for PostToolUse) prints failed checks with line/column issues by default; show_clean_runs: true also surfaces passing checks",
	],
};
