import type { PluginProse } from "./types";

export const lineage: PluginProse = {
	slug: "lineage",
	name: "Lineage",
	tagline: "Why does this line exist?",
	category: "analysis",
	problem:
		"A reviewer opens a file and asks: why is this conditional here? Git blame surfaces the commit, but the commit message is one line and the diff has fifty more. The prompt that motivated the change — the user's actual question, the constraint they were responding to — lived in a session whose transcript is gone. Scribe captures a session's intent in aggregate; Historian preserves transcripts; but neither links a specific line of code back to the turn that generated it. The why behind any given line evaporates the moment the session closes.",
	howItWorks: [
		"PostToolUse on Edit / Write / MultiEdit — derives the project key from cwd; reads the current turn from the session tracker",
		"Content extraction — pulls the added content from each edit, redacts secret-shaped substrings (AWS / GitHub / Anthropic / OpenAI keys, bearer tokens, KEY=value secrets), caps at max_snippet_chars (default: 4000)",
		"Appends one record to ~/.onlooker/lineage/<project-key>/changes.jsonl with session_id, turn, file_path, lines_added/removed, content_sha256, and the redacted added_snippets",
		"Emits a lean lineage.change.recorded carrying metadata + the SHA digest — never the content itself; the snippet lives only in the local ledger",
	],
};
