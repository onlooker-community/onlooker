import type { PluginProse } from "./types";

export const historian: PluginProse = {
	slug: "historian",
	name: "Historian",
	tagline: "Recalls past sessions when they matter.",
	category: "memory",
	problem:
		"A user hits a flaky test and the agent debugs it from scratch. Weeks earlier the same flake was investigated and the cause found, in a session whose transcript is gone. Librarian distills durable conclusions, but the verbatim shape of a past discussion, with its dead ends and rejected approaches, goes when the session ends. Historian preserves it.",
	howItWorks: [
		"On SessionEnd, Historian launches a detached indexer and returns at once, because the indexing pass does not fit in the time a SessionEnd hook is given.",
		"The indexer reads the transcript, keeps the user and assistant messages, splits them into overlapping chunks at turn boundaries, redacts secret-shaped substrings, and embeds each chunk through a local Ollama daemon.",
		"On UserPromptSubmit, it embeds your prompt, finds the most similar chunk from a past session, and injects an excerpt as context. Short prompts and rate-gated ones skip retrieval, and the current session's own chunks are excluded.",
		"A chunk stored without a vector, or a prompt that cannot be embedded, is matched by term overlap and ranks below every vector match. /historian backfill embeds the chunks that are missing a vector.",
	],
};
