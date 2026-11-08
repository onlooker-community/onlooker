import type { PluginProse } from "./types";

export const historian: PluginProse = {
	slug: "historian",
	name: "Historian",
	tagline: "Recalls past sessions when they matter.",
	category: "memory",
	problem:
		"A user hits a flaky test. The agent debugs from scratch. Three months ago the same flake was investigated, the root cause was identified, and the fix landed — all in a session whose transcript is gone. Librarian distills durable conclusions; archivist preserves session-level decisions. Neither preserves the verbatim shape of a past discussion. Without that, the dead-ends, the rejected approaches, and the actual rationale evaporate the moment the session ends.",
	howItWorks: [
		"SessionEnd — reads the full transcript at transcript_path; drops tool calls and tool results to keep semantically focused content",
		"Skips short sessions — under min_transcript_chars_to_index (default: 1200) is too short to plausibly produce a useful precedent",
		"Chunks at turn boundaries — accumulates turns up to chunk_target_chars (default: 2400) with chunk_overlap_chars (default: 400); never splits mid-turn",
		"Sanitizes — redacts secret-shaped substrings (AWS keys, bearer tokens, GitHub PATs, .env-style assignments), drops chunks tagged [historian:skip], drops chunks referencing never_index_paths",
	],
};
