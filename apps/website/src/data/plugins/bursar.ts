import type { PluginProse } from "./types";

export const bursar: PluginProse = {
	slug: "bursar",
	name: "Bursar",
	tagline: "What has this project cost me lately?",
	category: "governance",
	problem:
		'Governor caps a single session\'s spend, but the question that matters at the start of the next session isn\'t "is this run going to be expensive?" — it\'s "have I already spent more on this project this week than I realized?" One $4 session is forgettable; thirteen of them across a week is a number worth knowing before turn one. Without a rollup, the per-session signal Governor emits is structurally unable to answer the weekly-cost question, and the only place that data lives — the event log — is not where a human is looking at SessionStart.',
	howItWorks: [
		"SessionStart — derives the project key from cwd, writes a breadcrumb at $ONLOOKER_DIR/bursar/sessions/<session-id>.json so SessionEnd can attribute spend, then sums the per-project ledger over the active window and surfaces the total as additionalContext",
		"SessionEnd — resolves the ending session's project key (breadcrumb → substrate session tracker → live cwd), reads the session's spend from the latest governor.session.complete on the event bus, and upserts one record into the per-project ledger",
		"Reading off the bus, not the wire — Governor re-emits session.complete cumulatively; Bursar takes the last one to capture the session's final totals (total_cost_usd, total_tokens, total_api_calls)",
		"Idempotent recording — records are keyed by session_id, so a SessionEnd that fires more than once replaces the line rather than appending",
	],
};
