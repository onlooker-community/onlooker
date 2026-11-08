import type { PluginProse } from "./types";

export const ecosystem: PluginProse = {
	slug: "ecosystem",
	name: "Ecosystem",
	tagline: "The substrate the event-emitting plugins build on.",
	category: "substrate",
	problem:
		"Each Onlooker plugin writes to one shared, schema-validated event log, derives a stable project key from your git remote, and stores its artifacts under one root. That is what lets plugins compose without stepping on each other, and what makes every event queryable in one place. The ecosystem plugin is that always-on infrastructure, not a feature, so install it first.",
	howItWorks: [
		"Plugins that emit events depend on ecosystem, and no plugin calls another directly. They coordinate only by reading and writing the shared event log.",
		"Plugins emit canonical, schema-validated Onlooker events through one emitter, and nothing writes the log directly.",
		"Runtime artifacts live under $ONLOOKER_DIR (default $HOME/.onlooker/), namespaced per plugin and project.",
		"A project is keyed by the first 12 hex characters of SHA256 of its origin URL, falling back to the repo root for a checkout with no remote, so its history stays attached across clones and worktrees.",
	],
};
