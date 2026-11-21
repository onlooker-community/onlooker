/**
 * What the local dev seed creates (ONL-300), as plain data.
 *
 * Everything dated is built from `now`, so a seed run today and one next week
 * both show "the last 7 days". Nothing here touches a database or the network;
 * sql.ts and seed.ts turn it into rows and requests.
 *
 * The cases are chosen for the states the web app has to render, not to look
 * like a real account: each one is here because some view has a branch for it.
 */

/** One passphrase for every seed account. Local only; printed by the runner. */
export const SEED_PASSPHRASE = "onlooker-dev-seed";

/** The reset deletes every account on this domain, so nothing else may use it. */
export const SEED_DOMAIN = "onlooker.test";

export const ORG = { id: "seed-org", name: "Onlooker Dev" } as const;

export type UserKey = "dev" | "ada" | "sam";

export const USERS: Record<
	UserKey,
	{ id: string; email: string; name: string }
> = {
	// The account you log in as.
	dev: { id: "seed-user-dev", email: `dev@${SEED_DOMAIN}`, name: "Dev" },
	// In the org: the author of org lessons other than yours.
	ada: { id: "seed-user-ada", email: `ada@${SEED_DOMAIN}`, name: "Ada" },
	// Not in the org: the author of public lessons from outside it, and the
	// recipient of the pending invite.
	sam: { id: "seed-user-sam", email: `sam@${SEED_DOMAIN}`, name: "Sam" },
};

export const MEMBERSHIPS: {
	id: string;
	user: UserKey;
	role: "owner" | "member";
}[] = [
	{ id: "seed-membership-dev", user: "dev", role: "owner" },
	{ id: "seed-membership-ada", user: "ada", role: "member" },
];

/** An ISO time `days` (and `hours`) before `now`. Negative days are ahead. */
export function daysAgo(now: Date, days: number, hours = 0): string {
	return new Date(
		now.getTime() - (days * 24 + hours) * 3_600_000,
	).toISOString();
}

export interface SeedInvite {
	id: string;
	email: string;
	/** Hashed into the invite's token by seed.ts, so the link is the same every run. */
	tokenSeed: string;
	expiresAt: string;
}

export function invites(now: Date): SeedInvite[] {
	return [
		// Log in as sam and open the printed link to accept it.
		{
			id: "seed-invite-pending",
			email: USERS.sam.email,
			tokenSeed: "seed-invite-pending",
			expiresAt: daysAgo(now, -1),
		},
		{
			id: "seed-invite-expired",
			email: `former@${SEED_DOMAIN}`,
			tokenSeed: "seed-invite-expired",
			expiresAt: daysAgo(now, 2),
		},
	];
}

/** The CLI's inventory document, as PUT /machine/inventory stores it. */
export interface InventoryScope {
	scope: string;
	version: string;
	git_commit_sha: string | null;
	installed_at: string | null;
	last_updated: string | null;
	/** null: the CLI could not tell. */
	enabled: boolean | null;
}

export interface Inventory {
	schema_version: 1;
	collected_at: string;
	project: string | null;
	plugins: { id: string; scopes: InventoryScope[] }[];
}

function plugin(
	id: string,
	enabled: (boolean | null)[] = [true],
): Inventory["plugins"][number] {
	return {
		id,
		scopes: enabled.map((on, index) => ({
			scope: index === 0 ? "user" : "~/src/onlooker",
			version: "1.0.0",
			git_commit_sha: null,
			installed_at: null,
			last_updated: null,
			enabled: on,
		})),
	};
}

function inventory(now: Date, plugins: Inventory["plugins"]): Inventory {
	return {
		schema_version: 1,
		collected_at: daysAgo(now, 0, 2),
		project: null,
		plugins,
	};
}

export type MachineState = "live" | "never-used" | "revoked" | "removed";

export interface SeedMachine {
	id: string;
	owner: UserKey;
	name: string;
	/** Set for a token that pushes to the org: org lessons need one. */
	orgId: string | null;
	state: MachineState;
	createdDaysAgo: number;
	/** null for a machine that never pushed anything. */
	lastUsedHoursAgo: number | null;
	/** When a revoked or removed machine was retired. */
	retiredDaysAgo: number | null;
	inventory: Inventory | null;
}

export function machines(now: Date): SeedMachine[] {
	return [
		{
			id: "seed-desktop",
			owner: "dev",
			name: "seed desktop",
			orgId: null,
			state: "live",
			createdDaysAgo: 60,
			lastUsedHoursAgo: 1,
			retiredDaysAgo: null,
			inventory: inventory(now, [
				// Heard this week.
				plugin("historian@onlooker-community"),
				plugin("lineage@onlooker-community"),
				plugin("bursar@onlooker-community"),
				plugin("curator@onlooker-community"),
				plugin("tribunal@onlooker-community"),
				plugin("governor@onlooker-community"),
				plugin("inspector@onlooker-community"),
				plugin("librarian@onlooker-community"),
				plugin("archivist@onlooker-community"),
				// Installed, no events: listed as silent.
				plugin("counsel@onlooker-community"),
				// Enabled unknowably: still counts as installed, and silent.
				plugin("customs@onlooker-community", [null]),
				// Disabled in every scope: not installed.
				plugin("warden@onlooker-community", [false, false]),
				// Emits nothing under its own name: never listed.
				plugin("ecosystem@onlooker-community"),
				// Another marketplace: never an Onlooker plugin.
				plugin("superpowers@superpowers-dev"),
			]),
		},
		{
			id: "seed-laptop",
			owner: "dev",
			name: "seed laptop",
			orgId: ORG.id,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 3,
			retiredDaysAgo: null,
			inventory: inventory(now, [
				plugin("historian@onlooker-community"),
				plugin("lineage@onlooker-community"),
				plugin("counsel@onlooker-community"),
				plugin("ecosystem@onlooker-community"),
			]),
		},
		{
			id: "seed-spare",
			owner: "dev",
			name: "seed spare",
			orgId: null,
			state: "never-used",
			createdDaysAgo: 5,
			lastUsedHoursAgo: null,
			retiredDaysAgo: null,
			inventory: null,
		},
		{
			id: "seed-old-laptop",
			owner: "dev",
			name: "seed old laptop",
			orgId: null,
			state: "revoked",
			createdDaysAgo: 90,
			lastUsedHoursAgo: 20 * 24,
			retiredDaysAgo: 19,
			inventory: null,
		},
		{
			id: "seed-old-desktop",
			owner: "dev",
			name: "seed old desktop",
			orgId: null,
			state: "removed",
			createdDaysAgo: 120,
			lastUsedHoursAgo: 45 * 24,
			retiredDaysAgo: 40,
			inventory: null,
		},
		{
			id: "seed-ada-machine",
			owner: "ada",
			name: "ada's laptop",
			orgId: ORG.id,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 5,
			retiredDaysAgo: null,
			inventory: null,
		},
		{
			id: "seed-sam-machine",
			owner: "sam",
			name: "sam's desktop",
			orgId: null,
			state: "live",
			createdDaysAgo: 30,
			lastUsedHoursAgo: 8,
			retiredDaysAgo: null,
			inventory: null,
		},
	];
}

/** Project keys, 12 hex as the CLI derives them. Carried over from #254's seed. */
export const PROJECTS = {
	onlookerHttps: "a1b2c3d4e5f6",
	onlookerSsh: "b2c3d4e5f6a1",
	unnamed: "c3d4e5f6a1b2",
	scratch: "d4e5f6a1b2c3",
	retired: "e5f6a1b2c3d4",
	pastRetention: "f6a1b2c3d4e5",
} as const;

export interface SeedLabel {
	projectKey: string;
	/** "" for a remote key; the machine id for a root key. */
	machineId: string;
	label: string;
}

/** dev's own names for projects (`source = 'user'`). */
export const LABELS: SeedLabel[] = [
	// An https and an ssh clone of one repository: two keys, one name.
	{ projectKey: PROJECTS.onlookerHttps, machineId: "", label: "onlooker" },
	{ projectKey: PROJECTS.onlookerSsh, machineId: "", label: "onlooker" },
	// One root key on two machines: two projects, each with its own name.
	{
		projectKey: PROJECTS.scratch,
		machineId: "seed-desktop",
		label: "scratch on the desktop",
	},
	{
		projectKey: PROJECTS.scratch,
		machineId: "seed-laptop",
		label: "scratch on the laptop",
	},
	{
		projectKey: PROJECTS.retired,
		machineId: "seed-old-desktop",
		label: "retired experiment",
	},
	// Named, with no sessions at all: listed with no activity.
	{
		projectKey: PROJECTS.pastRetention,
		machineId: "",
		label: "archived project",
	},
];

/** One element of POST /machine/sessions' `sessions` array. */
export interface SessionBody {
	session_id: string;
	started_at: string;
	ended_at: string | null;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	/** Absent for a CLI older than 2.12.0. */
	counts_by_type?: Record<string, number>;
	counts_by_project: Record<
		string,
		{ basis: "remote" | "root"; event_count: number }
	>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

export interface SeedSession {
	machine: string;
	body: SessionBody;
}

/**
 * Plugin mixes, one per kind of row the web draws. `tool.*` and `session.*`
 * are the harness (observed), so they count toward a session's events and
 * never toward a plugin.
 */
const PROFILES: Record<
	string,
	{
		types?: Record<string, number>;
		prefixes?: Record<string, number>;
		plugins: string[];
	}
> = {
	produced: {
		types: {
			"historian.retrieval.started": 3,
			"historian.retrieval.complete": 3,
			"historian.retrieval.surfaced": 2,
			"lineage.change.recorded": 14,
			"bursar.session.recorded": 1,
			"tool.file.read": 30,
			"session.start": 1,
		},
		plugins: ["historian", "lineage", "bursar"],
	},
	failedBesideOutput: {
		types: {
			"historian.retrieval.surfaced": 1,
			"historian.embedder.failed": 2,
			"lineage.change.recorded": 6,
			"tool.file.read": 18,
		},
		plugins: ["historian", "lineage"],
	},
	failedOnly: {
		types: { "governor.ledger.write_failed": 1, "tool.file.read": 9 },
		plugins: ["governor"],
	},
	foundNothing: {
		types: {
			"curator.scan.started": 1,
			"curator.scan.complete": 1,
			"tool.file.read": 12,
		},
		plugins: ["curator"],
	},
	skipped: {
		types: { "tribunal.gate.skipped": 3, "tool.file.read": 7 },
		plugins: ["tribunal"],
	},
	unclassified: {
		types: { "futureplugin.signal.raised": 2, "tool.file.read": 5 },
		plugins: ["futureplugin"],
	},
	// archivist's output goes out under another plugin's prefix, so the
	// envelope's `plugins` is the only place it is heard.
	archivist: {
		types: { "onlooker.artifact.ready": 2, "tool.file.read": 11 },
		plugins: ["archivist"],
	},
	librarian: {
		types: {
			"librarian.candidate.proposed": 2,
			"librarian.lesson.promoted": 1,
			"tool.file.read": 20,
		},
		plugins: ["librarian"],
	},
	// A CLI older than 2.12.0: prefixes only, no per-type counts.
	oldCli: {
		prefixes: { inspector: 4, tool: 16 },
		plugins: ["inspector"],
	},
};

/** [machine, days ago, hours back, minutes long (null: running), profile, projects] */
type SessionRow = [
	string,
	number,
	number,
	number | null,
	keyof typeof PROFILES,
	[string, "remote" | "root", number][],
];

const P = PROJECTS;
const SESSION_ROWS: SessionRow[] = [
	[
		"seed-laptop",
		0,
		1,
		null,
		"failedBesideOutput",
		[[P.onlookerHttps, "remote", 318]],
	],
	["seed-desktop", 0, 4, 95, "produced", [[P.onlookerHttps, "remote", 1240]]],
	["seed-desktop", 0, 7, 40, "archivist", [[P.scratch, "root", 64]]],
	[
		"seed-laptop",
		1,
		2,
		120,
		"produced",
		[
			[P.onlookerSsh, "remote", 96],
			[P.unnamed, "remote", 41],
		],
	],
	[
		"seed-desktop",
		1,
		5,
		30,
		"foundNothing",
		[[P.onlookerHttps, "remote", 210]],
	],
	["seed-desktop", 1, 9, 15, "skipped", [[P.unnamed, "remote", 27]]],
	["seed-desktop", 2, 1, 10, "produced", [[P.onlookerHttps, "remote", 60]]],
	["seed-desktop", 2, 3, 200, "produced", [[P.onlookerHttps, "remote", 800]]],
	["seed-laptop", 2, 6, 45, "failedOnly", [[P.scratch, "root", 12]]],
	["seed-laptop", 2, 9, 60, "librarian", [[P.onlookerSsh, "remote", 140]]],
	// Nothing 3 days ago: a quiet day draws an empty bar.
	["seed-desktop", 4, 2, 75, "produced", [[P.onlookerHttps, "remote", 400]]],
	["seed-desktop", 4, 5, 20, "unclassified", [[P.unnamed, "remote", 18]]],
	[
		"seed-laptop",
		4,
		8,
		90,
		"failedBesideOutput",
		[[P.onlookerHttps, "remote", 260]],
	],
	["seed-laptop", 5, 2, 110, "produced", [[P.onlookerSsh, "remote", 300]]],
	["seed-desktop", 5, 5, 35, "oldCli", [[P.scratch, "root", 30]]],
	["seed-desktop", 5, 9, 25, "foundNothing", [[P.onlookerHttps, "remote", 90]]],
	["seed-laptop", 6, 1, 30, "produced", [[P.onlookerSsh, "remote", 70]]],
	["seed-desktop", 6, 3, 150, "produced", [[P.onlookerHttps, "remote", 520]]],
	["seed-laptop", 6, 6, 50, "skipped", [[P.unnamed, "remote", 33]]],
	["seed-desktop", 6, 9, 65, "librarian", [[P.onlookerHttps, "remote", 150]]],
	// Older than the week.
	["seed-laptop", 9, 2, 80, "produced", [[P.scratch, "root", 12]]],
	[
		"seed-old-laptop",
		20,
		3,
		60,
		"produced",
		[[P.onlookerHttps, "remote", 200]],
	],
	["seed-old-desktop", 45, 5, 120, "produced", [[P.retired, "root", 503]]],
];

function prefixesOf(types: Record<string, number>): Record<string, number> {
	const prefixes: Record<string, number> = {};
	for (const [type, count] of Object.entries(types)) {
		const prefix = type.slice(0, type.indexOf("."));
		prefixes[prefix] = (prefixes[prefix] ?? 0) + count;
	}
	return prefixes;
}

export function sessions(now: Date): SeedSession[] {
	return SESSION_ROWS.map(
		([machine, days, hours, minutes, profileName, projects], index) => {
			const profile = PROFILES[profileName];
			const counts_by_prefix = profile.types
				? prefixesOf(profile.types)
				: (profile.prefixes ?? {});
			const started = daysAgo(now, days, hours);
			const body: SessionBody = {
				session_id: `seed-session-${String(index + 1).padStart(2, "0")}`,
				started_at: started,
				ended_at:
					minutes === null
						? null
						: new Date(
								new Date(started).getTime() + minutes * 60_000,
							).toISOString(),
				event_count: Object.values(counts_by_prefix).reduce((a, b) => a + b, 0),
				counts_by_prefix,
				counts_by_project: Object.fromEntries(
					projects.map(([key, basis, event_count]) => [
						key,
						{ basis, event_count },
					]),
				),
				plugins: profile.plugins,
				prompts: 2 + (index % 5),
				compactions: index % 4 === 0 ? 1 : 0,
			};
			if (profile.types) body.counts_by_type = profile.types;
			return { machine, body };
		},
	);
}
