import type { PluginProse } from "./types";

export const inspector: PluginProse = {
	slug: "inspector",
	name: "Inspector",
	tagline: "Per-edit lint and typecheck, so the agent sees its own errors.",
	category: "quality",
	problem:
		"Elsewhere in the ecosystem, plugins judge agent output after the fact or gate ambiguous writes before they happen. Neither tells the agent, right after an edit, whether the code it just wrote compiles. Without that signal the agent has only its own belief that the last edit was right, and builds the next one on it.",
	howItWorks: [
		"On PostToolUse for Edit, Write and MultiEdit, Inspector resolves the touched file and looks up the checks you configured for its extension. Checks are opt-in per project, so with none configured it runs nothing.",
		"It runs each check against just that file, with a timeout per check and one for the whole run, then emits inspector.check.* events and a single inspector.run.completed summary.",
		"The hook's output reaches the agent on its next turn: failures with file, line and message. Clean runs stay quiet unless show_clean_runs is set.",
		"Inspector is advisory. It always exits 0 and never blocks the edit. A project-wide check such as tsc reports errors in every file, not only the touched one.",
	],
};
