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

import type { TLesson } from "@onlooker-community/lesson-contract";

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

export type SeedLessonBody = TLesson;

export type LessonEvent =
	| { at: string; kind: "push"; machine: string; lesson: SeedLessonBody }
	| {
			at: string;
			kind: "status";
			machine: string;
			lessonId: string;
			status: "refuted" | "superseded" | "retracted";
			supersededBy: string | null;
	  };

/** Fixed per author, 32 hex as the contract requires. */
const AUTHOR_KEYS: Record<UserKey, string> = {
	dev: "d".repeat(32),
	ada: "a".repeat(32),
	sam: "5".repeat(32),
};

/** A ULID-shaped id: "01JSEED", a digit per author, then a counter. */
function ulid(digit: number, n: number): string {
	return `01JSEED${digit}${String(n).padStart(18, "0")}`;
}

const AUTHOR_DIGIT: Record<UserKey, number> = { dev: 1, ada: 2, sam: 3 };

interface LessonSpec {
	author: UserKey;
	n: number;
	machine: string;
	claim: string;
	rationale: string;
	stack: string[];
	// Every fixture names a tool, so it never takes the no_stack scope, which
	// is legal only beside an empty stack.
	scope: Exclude<TLesson["applies_to"]["scope"], { kind: "no_stack" }>;
	visibility: TLesson["visibility"];
	projectKey: string;
	/** Days, then hours, before now. */
	promoted: [number, number];
	jury: [number, number];
}

function lessonFrom(now: Date, spec: LessonSpec): SeedLessonBody {
	const promotedAt = daysAgo(now, spec.promoted[0], spec.promoted[1]);
	return {
		id: ulid(AUTHOR_DIGIT[spec.author], spec.n),
		schema_version: 2,
		claim: spec.claim,
		rationale: spec.rationale,
		evidence: {
			artifact_ids: [ulid(9, AUTHOR_DIGIT[spec.author] * 100 + spec.n)],
			session_ids: [`seed-session-${String(spec.n).padStart(2, "0")}`],
			project_key: spec.projectKey,
			observed_at: daysAgo(now, spec.promoted[0], spec.promoted[1] + 2),
			resolution: "Confirmed on the next run.",
		},
		applies_to: {
			stack: spec.stack,
			scope: spec.scope,
			file_patterns: [],
			task_kinds: [],
		},
		visibility: spec.visibility,
		consensus: {
			judges: spec.jury[0],
			agreed: spec.jury[1],
			decided_at: promotedAt,
		},
		status: "active",
		superseded_by: null,
		source: spec.visibility === "private" ? "local" : spec.visibility,
		author_key: AUTHOR_KEYS[spec.author],
		promoted_at: promotedAt,
	};
}

const anyVersion = (justification: string) =>
	({ kind: "version_independent", justification }) as const;

export function lessonTimeline(now: Date): LessonEvent[] {
	const spec = (s: LessonSpec) => lessonFrom(now, s);
	const lessons: { machine: string; lesson: SeedLessonBody }[] = [
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 1,
				machine: "seed-desktop",
				claim: "Pin rollup when vite is below 6",
				rationale:
					"Vite 5 bundles a rollup range that drifts between installs.",
				stack: ["vite", "rollup"],
				scope: { kind: "versioned", versions: { vite: "<6" } },
				visibility: "private",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [13, 0],
				jury: [3, 2],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 2,
				machine: "seed-desktop",
				claim: "Run migrations before the worker deploys",
				rationale:
					"A worker that reads a column before it exists fails every request.",
				stack: ["wrangler", "d1"],
				scope: anyVersion("Ordering holds for any wrangler version."),
				visibility: "private",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [12, 0],
				jury: [3, 2],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 3,
				machine: "seed-desktop",
				claim: "Seed local data with wrangler d1 execute",
				rationale: "Raw SQL is the fastest way to fill a local database.",
				stack: ["wrangler", "d1"],
				scope: anyVersion("Applies to any local D1."),
				visibility: "private",
				projectKey: PROJECTS.scratch,
				promoted: [11, 0],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 5,
				machine: "seed-desktop",
				claim: "Cache bcrypt hashes between test runs",
				rationale: "Hashing at cost 10 dominates the suite's setup time.",
				stack: ["bcryptjs"],
				scope: anyVersion("Any bcryptjs."),
				visibility: "private",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [9, 0],
				jury: [3, 2],
			}),
		},
		{
			machine: "seed-laptop",
			lesson: spec({
				author: "dev",
				n: 6,
				machine: "seed-laptop",
				claim: "Bind a machine token to the org before pushing org lessons",
				rationale:
					"Ingest stamps org lessons with the token's org and nothing else.",
				stack: ["onlooker-cli"],
				scope: anyVersion("A rule of the API, not of a version."),
				visibility: "org",
				projectKey: PROJECTS.scratch,
				promoted: [8, 0],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 8,
				machine: "seed-desktop",
				claim: "Write timestamps as ISO strings with a trailing Z",
				rationale:
					"Lexical order then matches time order, which cursors rely on.",
				stack: ["typescript"],
				scope: anyVersion("Any runtime."),
				visibility: "public",
				projectKey: PROJECTS.unnamed,
				promoted: [6, 0],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-laptop",
			lesson: spec({
				author: "dev",
				n: 7,
				machine: "seed-laptop",
				claim: "Org lessons reach only members of the org",
				rationale:
					"The pool reads org lessons through the reader's memberships.",
				stack: ["drizzle-orm"],
				scope: { kind: "versioned", versions: { "drizzle-orm": "<1" } },
				visibility: "org",
				projectKey: PROJECTS.onlookerSsh,
				promoted: [4, 0],
				jury: [2, 2],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 4,
				machine: "seed-desktop",
				claim: "Push seed data through the API's ingest routes",
				rationale:
					"Ingest validates lessons and builds the derived tables; raw SQL skips both.",
				stack: ["wrangler", "d1"],
				scope: anyVersion("Applies to any local D1."),
				visibility: "private",
				projectKey: PROJECTS.scratch,
				promoted: [2, 3],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-desktop",
			lesson: spec({
				author: "dev",
				n: 9,
				machine: "seed-desktop",
				claim: "Pin workerd's compatibility date in tests",
				rationale:
					"Unpinned, the test runner asks for today's date and breaks at midnight.",
				stack: ["cloudflare-workers"],
				scope: anyVersion("Any workerd."),
				visibility: "public",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [0, 3],
				jury: [2, 2],
			}),
		},
		{
			machine: "seed-ada-machine",
			lesson: spec({
				author: "ada",
				n: 1,
				machine: "seed-ada-machine",
				claim: "Name the org in every invite email",
				rationale: "An invite that only names a person reads as spam.",
				stack: ["email"],
				scope: anyVersion("Any mail provider."),
				visibility: "org",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [10, 0],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-ada-machine",
			lesson: spec({
				author: "ada",
				n: 2,
				machine: "seed-ada-machine",
				claim: "Keep invite windows short in development",
				rationale:
					"A one-day window surfaces expiry handling in a single session.",
				stack: ["wrangler"],
				scope: anyVersion("A development setting."),
				visibility: "org",
				projectKey: PROJECTS.onlookerSsh,
				promoted: [3, 0],
				jury: [2, 2],
			}),
		},
		{
			machine: "seed-sam-machine",
			lesson: spec({
				author: "sam",
				n: 1,
				machine: "seed-sam-machine",
				claim: "Lowercase emails before comparing them",
				rationale: "Mixed-case signups otherwise fail invite matching.",
				stack: ["typescript"],
				scope: anyVersion("Any runtime."),
				visibility: "public",
				projectKey: PROJECTS.unnamed,
				promoted: [7, 0],
				jury: [3, 3],
			}),
		},
		{
			machine: "seed-sam-machine",
			lesson: spec({
				author: "sam",
				n: 2,
				machine: "seed-sam-machine",
				claim: "Cap request bodies by bytes, not array length",
				rationale: "A short array of huge items passes a length cap.",
				stack: ["cloudflare-workers"],
				scope: anyVersion("Any worker."),
				visibility: "public",
				projectKey: PROJECTS.onlookerHttps,
				promoted: [1, 0],
				jury: [3, 3],
			}),
		},
	];

	const pushes: LessonEvent[] = lessons.map(({ machine, lesson }) => ({
		at: lesson.promoted_at,
		kind: "push",
		machine,
		lesson,
	}));
	const changes: LessonEvent[] = [
		{
			at: daysAgo(now, 5),
			kind: "status",
			machine: "seed-desktop",
			lessonId: ulid(1, 2),
			status: "refuted",
			supersededBy: null,
		},
		{
			at: daysAgo(now, 2),
			kind: "status",
			machine: "seed-desktop",
			lessonId: ulid(1, 3),
			status: "superseded",
			supersededBy: ulid(1, 4),
		},
		{
			at: daysAgo(now, 1),
			kind: "status",
			machine: "seed-desktop",
			lessonId: ulid(1, 5),
			status: "retracted",
			supersededBy: null,
		},
	];
	return [...pushes, ...changes].sort((a, b) => a.at.localeCompare(b.at));
}
