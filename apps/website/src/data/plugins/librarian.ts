import type { PluginProse } from "./types";

export const librarian: PluginProse = {
	slug: "librarian",
	name: "Librarian",
	tagline: "Promotes what's worth keeping.",
	category: "memory",
	problem:
		"A user explains why the auth middleware is being rewritten: legal compliance, not tech debt. Archivist captures it as a decision, but archivist's artifacts are per-session notes, not durable memory. The typed memory store would hold the fact only if the user thought to say \"remember that.\" Most don't, so the fact never reaches it.",
	howItWorks: [
		"On SessionEnd, Librarian scans the artifacts archivist captured since its last watermark and runs a durability filter to decide which deserve to outlive the session.",
		"It classifies the survivors into the typed memory categories (user, feedback, project, reference) with a model call, and checks them for conflicts and duplicates against your existing memories.",
		"Candidates become proposals queued for your confirmation. By default Librarian never writes to the typed memory store directly.",
		"On SessionStart, if proposals are pending, it injects a single-line pointer to /librarian review. Accepted promotions land in the memory store with a source: librarian trailer.",
	],
};
