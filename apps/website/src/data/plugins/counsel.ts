import type { PluginProse } from "./types";

export const counsel: PluginProse = {
	slug: "counsel",
	name: "Counsel",
	tagline:
		"Your observability stack has been watching. Now it has something to say.",
	category: "analysis",
	problem:
		"Every Onlooker plugin writes its events to the same log, and the log is JSONL that no one reads. Each plugin reports on its own slice; nothing connects the dots across the stack. The signal exists. The synthesis doesn't. Counsel reads every plugin's events and turns them into a short brief.",
	howItWorks: [
		"On SessionStart, Counsel checks whether the project's latest brief is older than the synthesis interval. If it is fresh, or too few events fall inside the lookback window, the hook skips silently.",
		"If the brief is stale, it reads the lookback window of events from the onlooker log and runs a single claude -p synthesis pass for recurring patterns, recommendations with a priority, wins, and things to watch.",
		"The result is a Markdown brief, one per ISO week, written under ~/.onlooker/counsel/ and injected as invisible context.",
		"/counsel forces a fresh pass now and prints the brief in the conversation. /counsel --show prints the latest brief with no model call. The hook always exits 0 and never blocks a session from starting.",
	],
};
