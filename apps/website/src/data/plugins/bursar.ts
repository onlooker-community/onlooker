import type { PluginProse } from "./types";

export const bursar: PluginProse = {
	slug: "bursar",
	name: "Bursar",
	tagline: "What has this project cost me lately?",
	category: "governance",
	problem:
		'Governor regulates a single session, but the question at the start of the next one is different: not "is this run over budget?" but "what has this project cost me this week?" A per-session signal cannot answer that on its own, and the only place the data lives is the event log, which is not where you are looking at SessionStart. Bursar rolls each session\'s spend into a per-project ledger and tells you.',
	howItWorks: [
		"On SessionStart, Bursar derives the project key from the session's cwd, leaves a breadcrumb so SessionEnd can attribute the spend, then sums the project's ledger over the active window and surfaces the total as context.",
		"On SessionEnd, it resolves the project from that breadcrumb and reads the session's spend from the last governor.session.complete event on the shared event log.",
		"It upserts one record per session into the project's ledger, so a SessionEnd that fires more than once replaces the line instead of adding another.",
		"Governor is optional. Without it Bursar still records the session, and the message falls back to a session count.",
	],
};
