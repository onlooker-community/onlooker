import type { PluginData } from "./types";

export const counsel: PluginData = {
	slug: "counsel",
	name: "Counsel",
	version: "0.1.0",
	tagline:
		"Your observability stack has been watching. Now it has something to say.",
	category: "analysis",

	hero: {
		headline: "Turn weeks of agent logs into a coaching brief.",
		subheadline:
			"Counsel reads every plugin event from the last 30 days — tribunal verdicts, echo regressions, governor budget warnings, scribe intent documents, cartographer audit findings — and synthesizes a structured weekly brief that tells you what patterns are emerging, what to fix, and what is working.",
	},

	problem:
		"You've instrumented everything. Tribunal scores each session. Echo catches prompt regressions. Governor flags budget pressure. Scribe documents decisions. The data is there — but it sits in a JSONL log no one reads. Each plugin reports on its own slice; nothing connects the dots across the full stack. The signal exists. The synthesis doesn't.",

	howItWorks: [
		"On SessionStart — checks whether the last brief for this project is older than synthesis_interval_days (default: 7)",
		"If stale — reads the full onlooker-events.jsonl log over the configured lookback window (default: 30 days), filtering to events within range using ISO 8601 string comparison",
		"Identifies which plugin families contributed events: tribunal verdicts, echo regressions, and the broader onlooker event stream (governor, archivist, scribe, cartographer, compass)",
		"Runs a single Haiku synthesis pass over the filtered event batch, asking it to extract recurring patterns, actionable recommendations (with priority), wins, and trends to watch",
		"Formats findings as a structured Markdown brief with sections for Recommendations, Patterns Observed, Wins, and Watch",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell variable syntax in documentation string
		"Writes the brief to ${ONLOOKER_DIR}/counsel/<project-key>/briefs/<YYYY-WW>.md",
		"Injects the brief as additionalContext at session start — the same invisible injection pattern as Archivist — so you see it at the top of each session without being asked",
	],

	capabilities: [
		"Staleness gate — only synthesizes when the last brief is older than the configured interval; fresh briefs are injected silently without re-running the LLM pass",
		"Event-count gate — skips synthesis when the lookback window contains fewer than min_events (default: 10); low-signal periods produce no output rather than hallucinated recommendations",
		"Cross-plugin synthesis — reads all onlooker-community event types in a single pass; no per-plugin integration required",
		"Source attribution — tracks which plugin families contributed signal (tribunal_verdicts, echo_regressions, onlooker_events) and records them in the counsel.brief.generated event payload",
		"Priority-ranked recommendations — each recommendation carries a high / medium / low priority so you know where to start",
		"Wins section — explicitly surfaces what is working, not just what to fix; discourages over-rotating on problems",
		"Watch section — flags trends that are not urgent yet but worth monitoring; early-warning rather than post-mortem",
		"Brief char budget — injects at most brief_max_chars (default: 3000) into context; long briefs are truncated at the boundary so the injection never crowds out working context",
	],

	events: [
		{
			type: "counsel.brief.generated",
			when: "A new brief is synthesized and written at session start",
			keyFields:
				"period_start, period_end, recommendation_count, sources_consulted",
		},
	],

	config: `{
  "counsel": {
    "enabled": true,
    "synthesis_interval_days": 7,
    "lookback_days": 30,
    "evaluator": { "model": "claude-haiku-4-5-20251001", "timeout": 90 },
    "capture": { "min_events": 10 },
    "output": { "brief_max_chars": 3000 }
  }
}`,

	tags: [
		"observability",
		"synthesis",
		"coaching",
		"recommendations",
		"patterns",
		"weekly",
		"analysis",
	],

	idealFor:
		"Teams running multiple onlooker plugins who want a weekly coaching signal without manually reading event logs; projects where quality trends matter across sessions, not just within them; anyone who has instrumented their agent stack and wants the data to talk back.",
};
