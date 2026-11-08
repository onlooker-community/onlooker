import type { PluginProse } from "./types";

export const counsel: PluginProse = {
	slug: "counsel",
	name: "Counsel",
	tagline:
		"Your observability stack has been watching. Now it has something to say.",
	category: "analysis",
	problem:
		"You've instrumented everything. Tribunal scores each session. Echo catches prompt regressions. Governor flags budget pressure. Scribe documents decisions. The data is there — but it sits in a JSONL log no one reads. Each plugin reports on its own slice; nothing connects the dots across the full stack. The signal exists. The synthesis doesn't.",
	howItWorks: [
		"On SessionStart — checks whether the last brief for this project is older than synthesis_interval_days (default: 7)",
		"If stale — reads the full onlooker-events.jsonl log over the configured lookback window (default: 30 days), filtering to events within range using ISO 8601 string comparison",
		"Identifies which plugin families contributed events: tribunal verdicts, echo regressions, and the broader onlooker event stream (governor, archivist, scribe, cartographer, compass)",
		"Runs a single Haiku synthesis pass over the filtered event batch, asking it to extract recurring patterns, actionable recommendations (with priority), wins, and trends to watch",
	],
};
