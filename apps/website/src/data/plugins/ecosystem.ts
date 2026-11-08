import type { PluginProse } from "./types";

export const ecosystem: PluginProse = {
	slug: "ecosystem",
	name: "Ecosystem",
	tagline: "The substrate every other plugin builds on.",
	category: "substrate",
	problem:
		"Plugins that each keep their own files and their own log format cannot be queried together, and a project's history falls apart the moment it is cloned a second time. The ecosystem plugin is the shared ground that prevents that: one storage root, one event log, one way to name a project. It is infrastructure, not a feature, so install it before anything else.",
	howItWorks: [
		"Every other plugin depends on ecosystem, and none depends on another plugin. They coordinate only by reading and writing the shared event log.",
		"Plugins emit canonical, schema-validated Onlooker events through one emitter, and nothing writes the log directly.",
		"Runtime artifacts live under $ONLOOKER_DIR (default $HOME/.onlooker/), namespaced per plugin and project.",
		"A project is keyed by the first 12 hex characters of SHA256 of its git remote URL, so its history stays attached across clones and worktrees.",
	],
};
