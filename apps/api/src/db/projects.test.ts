import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createMachineToken } from "./machine-tokens.js";
import { setProjectLabel } from "./project-labels.js";
import { listProjects } from "./projects.js";
import { createUser } from "./queries.js";
import { type ProjectCount, putSessionSummaries } from "./session-summaries.js";

const db = () => env.DB;

const REMOTE = "aaaaaaaaaaaa";
const ROOT = "bbbbbbbbbbbb";

// Sourced from the migration itself, for the reason backfill.test.ts gives.
// The backfill is 0020's last statement by construction.
const BACKFILL =
	env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0020_"))?.queries.at(-1) ??
	"";

let userId: string;
let machineId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM session_projects").run();
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM project_labels").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM users").run();
	userId = (await createUser(db(), "p@example.com", "hash", "Ada")).id;
	machineId = (await createMachineToken(db(), userId, "laptop")).id;
});

/** Report one session for `machine`, touching whatever `counts` names. */
function report(
	session_id: string,
	started_at: string,
	counts_by_project?: Record<string, ProjectCount>,
	machine = machineId,
	user = userId,
) {
	return putSessionSummaries(db(), user, machine, [
		{
			session_id,
			started_at,
			ended_at: null,
			event_count: 10,
			counts_by_prefix: { tool: 10 },
			// Omitted on purpose when undefined: an older CLI sends none.
			counts_by_project: counts_by_project as Record<string, ProjectCount>,
			plugins: [],
			prompts: 1,
			compactions: 0,
		},
	]);
}

const remote = (event_count: number): ProjectCount => ({
	basis: "remote",
	event_count,
});
const root = (event_count: number): ProjectCount => ({
	basis: "root",
	event_count,
});

async function rows(): Promise<
	{
		session_id: string;
		project_key: string;
		basis: string;
		event_count: number;
	}[]
> {
	const { results } = await db()
		.prepare(
			`SELECT session_id, project_key, basis, event_count
			   FROM session_projects ORDER BY session_id, project_key`,
		)
		.all<{
			session_id: string;
			project_key: string;
			basis: string;
			event_count: number;
		}>();
	return results;
}

describe("putSessionSummaries and session_projects", () => {
	it("writes a row per project a session touched", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", {
			[REMOTE]: remote(7),
			[ROOT]: root(3),
		});

		expect(await rows()).toEqual([
			{
				session_id: "s1",
				project_key: REMOTE,
				basis: "remote",
				event_count: 7,
			},
			{ session_id: "s1", project_key: ROOT, basis: "root", event_count: 3 },
		]);
	});

	// This is why the write deletes first: an upsert would leave ROOT behind.
	it("replaces a session's rows on the next sync", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", {
			[REMOTE]: remote(7),
			[ROOT]: root(3),
		});
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(9) });

		expect(await rows()).toEqual([
			{
				session_id: "s1",
				project_key: REMOTE,
				basis: "remote",
				event_count: 9,
			},
		]);
	});

	it("leaves other sessions' rows alone", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(7) });
		await report("s2", "2026-01-02T00:00:00.000Z", { [REMOTE]: remote(4) });
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(8) });

		expect(await rows()).toEqual([
			{
				session_id: "s1",
				project_key: REMOTE,
				basis: "remote",
				event_count: 8,
			},
			{
				session_id: "s2",
				project_key: REMOTE,
				basis: "remote",
				event_count: 4,
			},
		]);
	});

	it("writes nothing for a session with no projects", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", {});
		await report("s2", "2026-01-01T00:00:00.000Z");

		expect(await rows()).toEqual([]);
	});

	// A single multi-row insert would cross D1's 100 bound parameters here.
	it("takes a session touching twenty projects", async () => {
		const counts: Record<string, ProjectCount> = {};
		for (let i = 0; i < 20; i++) {
			counts[i.toString(16).padStart(12, "0")] = remote(i + 1);
		}
		await report("s1", "2026-01-01T00:00:00.000Z", counts);

		expect(await rows()).toHaveLength(20);
	});

	it("goes with its summary", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(7) });
		await db().prepare("DELETE FROM session_summaries").run();

		expect(await rows()).toEqual([]);
	});
});

describe("listProjects", () => {
	let second: string;

	beforeEach(async () => {
		second = (await createMachineToken(db(), userId, "desktop")).id;
	});

	it("adds a remote key up across machines", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(7) });
		await report(
			"s2",
			"2026-01-05T00:00:00.000Z",
			{ [REMOTE]: remote(5) },
			second,
		);

		expect(await listProjects(db(), userId)).toEqual([
			{
				project_key: REMOTE,
				basis: "remote",
				machine_id: null,
				sessions: 2,
				events: 12,
				last_seen_at: "2026-01-05T00:00:00.000Z",
			},
		]);
	});

	it("keeps a root key per machine", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", { [ROOT]: root(7) });
		await report("s2", "2026-01-05T00:00:00.000Z", { [ROOT]: root(5) }, second);

		const projects = await listProjects(db(), userId);

		expect(projects).toHaveLength(2);
		expect(projects.map((p) => p.machine_id).sort()).toEqual(
			[machineId, second].sort(),
		);
		expect(projects.every((p) => p.basis === "root" && p.sessions === 1)).toBe(
			true,
		);
	});

	it("lists only this user's projects", async () => {
		const other = await createUser(db(), "o@example.com", "hash", "Bob");
		const theirs = (await createMachineToken(db(), other.id, "theirs")).id;
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(7) });
		await report(
			"s9",
			"2026-01-01T00:00:00.000Z",
			{ [ROOT]: root(2) },
			theirs,
			other.id,
		);

		const projects = await listProjects(db(), userId);

		expect(projects.map((p) => p.project_key)).toEqual([REMOTE]);
	});

	it("keeps a labeled key past retention", async () => {
		await setProjectLabel(db(), userId, {
			project_key: REMOTE,
			machine_id: null,
			label: "onlooker",
		});
		await setProjectLabel(db(), userId, {
			project_key: ROOT,
			machine_id: machineId,
			label: "scratch",
		});

		const projects = await listProjects(db(), userId);

		expect(projects).toEqual([
			{
				project_key: REMOTE,
				basis: "remote",
				machine_id: null,
				sessions: 0,
				events: 0,
				last_seen_at: null,
			},
			{
				project_key: ROOT,
				basis: "root",
				machine_id: machineId,
				sessions: 0,
				events: 0,
				last_seen_at: null,
			},
		]);
	});

	it("does not add a second row for a labeled key that has sessions", async () => {
		await report("s1", "2026-01-01T00:00:00.000Z", {
			[REMOTE]: remote(7),
			[ROOT]: root(3),
		});
		await setProjectLabel(db(), userId, {
			project_key: REMOTE,
			machine_id: null,
			label: "onlooker",
		});
		await setProjectLabel(db(), userId, {
			project_key: ROOT,
			machine_id: machineId,
			label: "scratch",
		});

		const projects = await listProjects(db(), userId);

		expect(projects).toHaveLength(2);
		expect(projects.every((p) => p.sessions === 1)).toBe(true);
	});

	it("lists the most recently seen first, and never-seen last", async () => {
		const NEVER = "cccccccccccc";
		await report("s1", "2026-01-01T00:00:00.000Z", { [REMOTE]: remote(7) });
		await report("s2", "2026-02-01T00:00:00.000Z", { [ROOT]: root(3) });
		await setProjectLabel(db(), userId, {
			project_key: NEVER,
			machine_id: null,
			label: "old",
		});

		const projects = await listProjects(db(), userId);

		expect(projects.map((p) => p.project_key)).toEqual([ROOT, REMOTE, NEVER]);
	});
});

describe("the 0020 backfill", () => {
	// Guards the lookup above, which would otherwise fall back to "" and let
	// every test below pass while asserting nothing.
	it("resolves an INSERT statement from the migration file", () => {
		expect(BACKFILL).toContain("INSERT INTO `session_projects`");
	});

	async function seed(sessionId: string, countsByProject: string) {
		await db()
			.prepare(
				`INSERT INTO session_summaries
					(user_id, machine_id, session_id, started_at, event_count,
					 counts_by_prefix, counts_by_project, plugins)
				 VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 1, '{}', ?, '[]')`,
			)
			.bind(userId, machineId, sessionId, countsByProject)
			.run();
	}

	it("indexes each key of a session that has some, and skips the rest", async () => {
		await seed(
			"has-keys",
			JSON.stringify({ [REMOTE]: remote(7), [ROOT]: root(3) }),
		);
		await seed("empty", "{}");
		await seed("malformed", "not json");
		// Valid JSON of the wrong shape must not abort the migration either.
		await seed("scalar", "5");
		await seed("array", "[1, 2]");
		await seed("odd-value", JSON.stringify({ [REMOTE]: 7 }));

		await db().prepare(BACKFILL).run();

		expect(await rows()).toEqual([
			{
				session_id: "has-keys",
				project_key: REMOTE,
				basis: "remote",
				event_count: 7,
			},
			{
				session_id: "has-keys",
				project_key: ROOT,
				basis: "root",
				event_count: 3,
			},
		]);
	});
});
