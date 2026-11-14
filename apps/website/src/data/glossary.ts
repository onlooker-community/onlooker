/**
 * The terms /glossary defines, in the order it shows them. Posts link a term
 * with <Term id="...">, which fails the build for an id that is not here.
 *
 * Plugin names are not entries: each has a /plugins/<name> page fed from the
 * marketplace, and a second definition here would drift from it.
 *
 * The id is the anchor (/glossary/#<id>), so renaming one breaks every link
 * to it that lives outside this site. Add a new id rather than rename.
 */
export interface GlossaryEntry {
	id: string;
	term: string;
	definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
	{
		id: "contrast-arena",
		term: "Contrast arena",
		definition:
			"A second repository where the plugins run so that their behavior can be compared with what the home repo shows. It isn't a second rollout: it runs a fixed set of plugins with no wave schedule of its own.",
	},
	{
		id: "dogfooding",
		term: "Dogfooding",
		definition:
			"Running Onlooker's plugins on our own repositories while we build them. Most of what we publish was measured that way.",
	},
	{
		id: "event-bus",
		term: "Event bus",
		definition:
			"The shared event log that Onlooker plugins write to. Each event has a name like tool.shell.exec or lineage.change.recorded, so one plugin, or a person, can see what the others recorded.",
	},
	{
		id: "gate",
		term: "Gate",
		definition:
			"A hook that can stop a tool call before it runs, or flag one after it does, until a check passes. Examples are a lint check after an edit, a secret scan before a shell command leaves the machine, and a confidence check before a write.",
	},
	{
		id: "home-repo",
		term: "Home repo",
		definition:
			"The repository a plugin is developed and dogfooded in first. For the marketplace plugins, that's the ecosystem repo.",
	},
	{
		id: "hook",
		term: "Hook",
		definition:
			"A script that Claude Code runs at a fixed point in a session, such as when a session starts or after a tool call. Onlooker's plugins do their work through hooks.",
	},
	{
		id: "hook-health-log",
		term: "Hook-health log",
		definition:
			"A record of every hook that ran: which plugin, which hook, how long it took, whether it succeeded. It's how we confirm a plugin is actually running before we trust anything it measured.",
	},
	{
		id: "jury",
		term: "Jury",
		definition:
			"A panel of AI judges that scores work against a rubric before it's accepted. For lessons, the jury gets one pass: a candidate that falls short is dropped, not revised, because a wrong lesson misleads people and a missing one only fails to help.",
	},
	{
		id: "ledger",
		term: "Ledger",
		definition:
			"An append-only record a plugin keeps over time. For example, lineage's ledger records which change wrote which line, and bursar's records what each project spent.",
	},
	{
		id: "lesson",
		term: "Lesson",
		definition:
			"Something learned in a real session, written down so other people can use it. It states a claim, why the claim follows, what fixed the problem, and the versions it holds for. Outside those versions, it doesn't apply. A lesson can stay private or be shared with your org or the public. It can later be refuted, superseded or retracted, but it never just expires.",
	},
	{
		id: "lesson-candidate",
		term: "Lesson candidate",
		definition:
			"A possible lesson that librarian drafted from a session's decisions and dead ends. Nothing is shared until you confirm a candidate and choose who can see it, and the jury approves it.",
	},
	{
		id: "substrate",
		term: "Substrate",
		definition:
			"The base layer the other Onlooker plugins build on. It provides the shared storage directory, the event format every plugin writes, and the hooks that track sessions and tool calls. In the marketplace, it's the category the ecosystem plugin belongs to.",
	},
	{
		id: "wave",
		term: "Wave",
		definition:
			"One stage of rolling plugins out onto a repo. Each wave turns on a set of plugins, then measures them before the next set is added.",
	},
];
