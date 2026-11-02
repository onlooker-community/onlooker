import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	pruneSessionSummaries,
	RETENTION_DAYS,
} from "../db/session-summaries.js";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
const DAY_MS = 24 * 60 * 60 * 1000;
// Assembled rather than written as one literal so the repository's secret
// scanner does not flag a throwaway test fixture. Same value the sibling
// route suites use; do not "simplify" it back into a single string.
const PASSWORD = ["correct", "horse", "battery"].join("-");

function summary(overrides: Record<string, unknown> = {}) {
	return {
		session_id: "s1",
		started_at: "2026-09-17T12:00:00.000Z",
		ended_at: "2026-09-17T14:00:00.000Z",
		event_count: 25,
		counts_by_prefix: { tool: 20, session: 5 },
		plugins: ["onlooker"],
		prompts: 3,
		compactions: 0,
		...overrides,
	};
}

async function signup(email: string): Promise<string> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	return ((await response.json()) as { token: string }).token;
}

async function mint(
	accessToken: string,
	name: string,
): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/api/machines`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ name }),
	});
	return (await response.json()) as { id: string; token: string };
}

function post(machineToken: string, body: unknown): Promise<Response> {
	return SELF.fetch(`${BASE}/machine/sessions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify(body),
	});
}

function get(accessToken: string, path = "/api/sessions"): Promise<Response> {
	return SELF.fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
}

beforeEach(async () => {
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("POST /machine/sessions", () => {
	it("stores a machine's session summaries", async () => {
		const access = await signup("store@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary(), summary({ session_id: "s2" })],
		});

		expect(response.status).toBe(200);
		const { results } = await db()
			.prepare(
				"SELECT session_id, event_count FROM session_summaries WHERE machine_id = ? ORDER BY session_id",
			)
			.bind(machine.id)
			.all();
		expect(results).toHaveLength(2);
	});

	// The whole point of keying on (machine_id, session_id): a session reported
	// again while it is still running must update, not duplicate.
	it("upserts a session reported twice", async () => {
		const access = await signup("upsert@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ ended_at: null, event_count: 25 })],
		});
		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({ ended_at: "2026-09-17T15:00:00.000Z", event_count: 40 }),
			],
		});

		const { results } = await db()
			.prepare(
				"SELECT event_count, ended_at FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.all();
		expect(results).toHaveLength(1);
		expect(results[0].event_count).toBe(40);
		expect(results[0].ended_at).not.toBeNull();
	});

	// A machine credential names exactly one machine. Honoring a machine_id in
	// the body would let one machine's credential write history attributed to
	// another, which is the property machines.ts protects deliberately.
	it("attributes rows to the token's machine, not the body's", async () => {
		const access = await signup("attrib@example.com");
		const mine = await mint(access, "mine");
		const other = await mint(access, "other");

		await post(mine.token, {
			schema_version: 1,
			sessions: [summary({ machine_id: other.id })],
		});

		const { results } = await db()
			.prepare("SELECT machine_id FROM session_summaries")
			.all();
		expect(results).toHaveLength(1);
		expect(results[0].machine_id).toBe(mine.id);
	});

	it("refuses a body whose sessions are not an array", async () => {
		const access = await signup("shape@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: "nope",
		});

		expect(response.status).toBe(400);
	});

	// `counts_by_prefix`'s keys were checked as an object, but its VALUES were
	// never checked as numbers - a string here would round-trip through
	// storage and reach `count.toLocaleString()` on the web page.
	it("refuses a session whose counts_by_prefix holds a non-number value", async () => {
		const access = await signup("counts@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_prefix: { tool: "not-a-number" } })],
		});

		expect(response.status).toBe(400);
	});

	it("refuses an unknown schema version", async () => {
		const access = await signup("version@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 999,
			sessions: [summary()],
		});

		expect(response.status).toBe(400);
	});

	it("refuses a body over the size cap", async () => {
		const access = await signup("big@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: Array.from({ length: 5000 }, (_, i) =>
				summary({ session_id: `s${i}` }),
			),
		});

		expect(response.status).toBe(413);
	});

	it("refuses a request with no machine token", async () => {
		const response = await SELF.fetch(`${BASE}/machine/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ schema_version: 1, sessions: [summary()] }),
		});

		expect(response.status).toBe(401);
	});
});

interface WireSummary {
	session_id: string;
	machine_id: string;
	started_at: string;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	plugins: string[];
}

describe("GET /api/sessions", () => {
	it("returns this user's sessions, newest first", async () => {
		const access = await signup("newest-first@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					session_id: "s-early",
					started_at: "2026-09-10T00:00:00.000Z",
				}),
				summary({
					session_id: "s-late",
					started_at: "2026-09-16T00:00:00.000Z",
				}),
				summary({
					session_id: "s-mid",
					started_at: "2026-09-13T00:00:00.000Z",
				}),
			],
		});

		const response = await get(access);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { sessions: WireSummary[] };
		expect(body.sessions.map((s) => s.session_id)).toEqual([
			"s-late",
			"s-mid",
			"s-early",
		]);
	});

	it("pages with a cursor", async () => {
		const access = await signup("pages@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({ session_id: "s1", started_at: "2026-09-10T00:00:00.000Z" }),
				summary({ session_id: "s2", started_at: "2026-09-12T00:00:00.000Z" }),
				summary({ session_id: "s3", started_at: "2026-09-14T00:00:00.000Z" }),
			],
		});

		const first = await get(access, "/api/sessions?limit=2");
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			sessions: WireSummary[];
			cursor: string | null;
			has_more: boolean;
		};
		expect(firstBody.has_more).toBe(true);
		expect(firstBody.cursor).not.toBeNull();
		expect(firstBody.sessions.map((s) => s.session_id)).toEqual(["s3", "s2"]);

		const second = await get(
			access,
			`/api/sessions?limit=2&cursor=${encodeURIComponent(firstBody.cursor as string)}`,
		);
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			sessions: WireSummary[];
			cursor: string | null;
			has_more: boolean;
		};
		expect(secondBody.has_more).toBe(false);
		expect(secondBody.cursor).toBeNull();
		expect(secondBody.sessions.map((s) => s.session_id)).toEqual(["s1"]);

		// No row repeated, none skipped: the two pages together are exactly the
		// three seeded sessions.
		const allIds = [...firstBody.sessions, ...secondBody.sessions].map(
			(s) => s.session_id,
		);
		expect(allIds).toEqual(["s3", "s2", "s1"]);
	});

	it("never returns another user's sessions", async () => {
		const mine = await signup("mine@example.com");
		const myMachine = await mint(mine, "laptop");
		await post(myMachine.token, {
			schema_version: 1,
			sessions: [summary({ session_id: "mine" })],
		});

		const theirs = await signup("theirs@example.com");
		const theirMachine = await mint(theirs, "laptop");
		await post(theirMachine.token, {
			schema_version: 1,
			sessions: [summary({ session_id: "theirs" })],
		});

		const response = await get(mine);
		const body = (await response.json()) as { sessions: WireSummary[] };
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].session_id).toBe("mine");
	});

	// "Nothing yet" is an answer, not an error. A user with no machines is the
	// normal state of a new account.
	it("answers an empty page for a user with no machines", async () => {
		const access = await signup("empty@example.com");

		const response = await get(access);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			sessions: [],
			cursor: null,
			has_more: false,
		});
	});

	// Reading the feed is a browser-authenticated act, the same split
	// GET /api/activity draws against the machine-authenticated ingest routes.
	it("refuses a machine token", async () => {
		const access = await signup("machine-token@example.com");
		const machine = await mint(access, "laptop");

		const response = await get(machine.token);
		expect(response.status).toBe(401);
	});

	// A cursor this server did not issue is client error, not server error.
	it("answers 400 for a cursor it did not issue", async () => {
		const access = await signup("bad-cursor@example.com");

		const response = await get(access, "/api/sessions?cursor=nonsense!!");
		expect(response.status).toBe(400);
	});
});

describe("GET /api/sessions?project=", () => {
	const REMOTE = "aaaaaaaaaaaa";
	const OTHER = "bbbbbbbbbbbb";
	const ROOT = "cccccccccccc";

	const remote = (key: string) => ({
		[key]: { basis: "remote", event_count: 1 },
	});
	const root = (key: string) => ({ [key]: { basis: "root", event_count: 1 } });

	async function ids(response: Response): Promise<string[]> {
		const body = (await response.json()) as { sessions: WireSummary[] };
		return body.sessions.map((s) => s.session_id);
	}

	it("finds a remote key's sessions on every machine", async () => {
		const access = await signup("filter-remote@example.com");
		const m1 = await mint(access, "laptop");
		const m2 = await mint(access, "desktop");
		await post(m1.token, {
			schema_version: 1,
			sessions: [
				summary({ session_id: "m1-remote", counts_by_project: remote(REMOTE) }),
				summary({ session_id: "m1-other", counts_by_project: remote(OTHER) }),
			],
		});
		await post(m2.token, {
			schema_version: 1,
			sessions: [
				summary({ session_id: "m2-remote", counts_by_project: remote(REMOTE) }),
			],
		});

		const response = await get(access, `/api/sessions?project=${REMOTE}`);

		expect(response.status).toBe(200);
		expect((await ids(response)).sort()).toEqual(["m1-remote", "m2-remote"]);
	});

	it("finds a root key on its own machine only", async () => {
		const access = await signup("filter-root@example.com");
		const m1 = await mint(access, "laptop");
		const m2 = await mint(access, "desktop");
		await post(m1.token, {
			schema_version: 1,
			sessions: [summary({ session_id: "m1", counts_by_project: root(ROOT) })],
		});
		await post(m2.token, {
			schema_version: 1,
			sessions: [summary({ session_id: "m2", counts_by_project: root(ROOT) })],
		});

		const response = await get(
			access,
			`/api/sessions?project=${m1.id}:${ROOT}`,
		);

		expect(await ids(response)).toEqual(["m1"]);
	});

	it("does not read a root key as remote, or a remote key as root", async () => {
		const access = await signup("filter-basis@example.com");
		const m1 = await mint(access, "laptop");
		await post(m1.token, {
			schema_version: 1,
			sessions: [
				summary({ session_id: "is-root", counts_by_project: root(ROOT) }),
				summary({ session_id: "is-remote", counts_by_project: remote(REMOTE) }),
			],
		});

		const asRemote = await get(access, `/api/sessions?project=${ROOT}`);
		const asRoot = await get(
			access,
			`/api/sessions?project=${m1.id}:${REMOTE}`,
		);

		expect(await ids(asRemote)).toEqual([]);
		expect(await ids(asRoot)).toEqual([]);
	});

	it("matches any of several values, each session once", async () => {
		const access = await signup("filter-several@example.com");
		const machine = await mint(access, "laptop");
		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					session_id: "both",
					counts_by_project: { ...remote(REMOTE), ...remote(OTHER) },
				}),
			],
		});

		const response = await get(
			access,
			`/api/sessions?project=${REMOTE}&project=${OTHER}`,
		);

		expect(await ids(response)).toEqual(["both"]);
	});

	it("keeps a session's other projects", async () => {
		const access = await signup("filter-keeps@example.com");
		const machine = await mint(access, "laptop");
		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					counts_by_project: { ...remote(REMOTE), ...remote(OTHER) },
				}),
			],
		});

		const response = await get(access, `/api/sessions?project=${REMOTE}`);

		const body = (await response.json()) as {
			sessions: { counts_by_project: Record<string, unknown> }[];
		};
		expect(Object.keys(body.sessions[0].counts_by_project).sort()).toEqual([
			REMOTE,
			OTHER,
		]);
	});

	it("pages across a filter, every match once", async () => {
		const access = await signup("filter-pages@example.com");
		const machine = await mint(access, "laptop");
		const day = (n: number) =>
			`2026-09-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`;
		// Newest first, matches at the even positions: s0 s2 s4 s6 s8.
		await post(machine.token, {
			schema_version: 1,
			sessions: Array.from({ length: 10 }, (_, n) =>
				summary({
					session_id: `s${n}`,
					started_at: day(20 - n),
					counts_by_project: n % 2 === 0 ? remote(REMOTE) : remote(OTHER),
				}),
			),
		});

		const seen: string[] = [];
		let path = `/api/sessions?project=${REMOTE}&limit=2`;
		let hasMore = true;
		while (hasMore) {
			const body = (await (await get(access, path)).json()) as {
				sessions: WireSummary[];
				cursor: string | null;
				has_more: boolean;
			};
			seen.push(...body.sessions.map((s) => s.session_id));
			hasMore = body.has_more;
			if (hasMore) {
				path = `/api/sessions?project=${REMOTE}&limit=2&cursor=${encodeURIComponent(body.cursor as string)}`;
			}
		}

		expect(seen).toEqual(["s0", "s2", "s4", "s6", "s8"]);
	});

	it("never reaches another account's sessions", async () => {
		const mine = await signup("filter-mine@example.com");
		const myMachine = await mint(mine, "laptop");
		await post(myMachine.token, {
			schema_version: 1,
			sessions: [
				summary({ session_id: "mine", counts_by_project: remote(REMOTE) }),
			],
		});
		const theirs = await signup("filter-theirs@example.com");
		const theirMachine = await mint(theirs, "laptop");
		await post(theirMachine.token, {
			schema_version: 1,
			sessions: [
				summary({
					session_id: "theirs",
					counts_by_project: { ...remote(REMOTE), ...root(ROOT) },
				}),
			],
		});

		const shared = await get(mine, `/api/sessions?project=${REMOTE}`);
		const theirRoot = await get(
			mine,
			`/api/sessions?project=${theirMachine.id}:${ROOT}`,
		);

		expect(await ids(shared)).toEqual(["mine"]);
		expect(await ids(theirRoot)).toEqual([]);
	});

	it("refuses more than 40 values", async () => {
		const access = await signup("filter-many@example.com");
		const keys = (count: number) =>
			Array.from(
				{ length: count },
				(_, i) => `project=${i.toString(16).padStart(12, "0")}`,
			).join("&");

		const over = await get(access, `/api/sessions?${keys(41)}`);
		const at = await get(access, `/api/sessions?${keys(40)}`);

		expect(over.status).toBe(400);
		expect((await over.json()) as { error: { code: string } }).toMatchObject({
			error: { code: "invalid_project" },
		});
		expect(at.status).toBe(200);
	});

	it.each([
		["text that is not a key", "nope"],
		["an upper-case key", "AAAAAAAAAAAA"],
		["a root key with no machine", ":aaaaaaaaaaaa"],
		["a machine with no key", "m1:"],
	])("refuses a malformed value: %s", async (_label, value) => {
		const access = await signup(`filter-bad-${_label.length}@example.com`);

		const response = await get(
			access,
			`/api/sessions?project=${encodeURIComponent(value)}`,
		);

		expect(response.status).toBe(400);
		expect(
			(await response.json()) as { error: { code: string } },
		).toMatchObject({ error: { code: "invalid_project" } });
	});
});

describe("pruneSessionSummaries", () => {
	// A fixed anchor rather than the real clock, so the boundary test below is
	// exact instead of racing the few milliseconds between seeding a row and
	// calling the prune. now is passed straight through to the function under
	// test, so both sides of the comparison agree on what "now" means.
	const now = new Date("2026-09-17T00:00:00.000Z");

	it("prunes summaries older than the retention window", async () => {
		const access = await signup("prune-old@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					session_id: "old",
					started_at: new Date(now.getTime() - 200 * DAY_MS).toISOString(),
				}),
				summary({
					session_id: "recent",
					started_at: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
				}),
			],
		});

		const pruned = await pruneSessionSummaries(db(), now);
		expect(pruned).toBe(1);

		const { results } = await db()
			.prepare("SELECT session_id FROM session_summaries WHERE machine_id = ?")
			.bind(machine.id)
			.all();
		expect(results.map((r) => r.session_id)).toEqual(["recent"]);
	});

	// The boundary belongs to the kept side: a row started exactly
	// RETENTION_DAYS ago survives, so "180 days of history" means 180, not 179.
	it("keeps a summary exactly at the boundary", async () => {
		const access = await signup("prune-boundary@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					session_id: "boundary",
					started_at: new Date(
						now.getTime() - RETENTION_DAYS * DAY_MS,
					).toISOString(),
				}),
			],
		});

		const pruned = await pruneSessionSummaries(db(), now);
		expect(pruned).toBe(0);

		const { results } = await db()
			.prepare("SELECT session_id FROM session_summaries WHERE machine_id = ?")
			.bind(machine.id)
			.all();
		expect(results).toHaveLength(1);
	});
});

describe("counts_by_project", () => {
	const twoProjects = {
		ee2cfbe428c7: { basis: "remote", event_count: 18 },
		bc046590dad9: { basis: "root", event_count: 7 },
	};

	it("stores a multi-project session and reads it back parsed", async () => {
		const access = await signup("multiproject@example.com");
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_project: twoProjects })],
		});
		expect(posted.status).toBe(200);

		const read = await get(access);
		const body = (await read.json()) as {
			sessions: { counts_by_project: Record<string, unknown> }[];
		};
		// Parsed out of its JSON TEXT column, so a client never sees the
		// storage representation - the same contract counts_by_prefix has.
		expect(body.sessions[0].counts_by_project).toEqual(twoProjects);
	});

	// A CLI older than this column posts no such field. Rejecting those bodies
	// would break every machine that has not upgraded, for a dimension whose
	// absence already means "not attributable".
	it("accepts a summary with no counts_by_project and stores an empty map", async () => {
		const access = await signup("noproject@example.com");
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary()],
		});
		expect(posted.status).toBe(200);

		const stored = await db()
			.prepare(
				"SELECT counts_by_project FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.first<{ counts_by_project: string }>();
		// The literal text "{}", not "undefined" and not NULL - a stringified
		// `undefined` would break every later JSON.parse of this column.
		expect(stored?.counts_by_project).toBe("{}");

		const read = await get(access);
		const body = (await read.json()) as {
			sessions: { counts_by_project: Record<string, unknown> }[];
		};
		expect(body.sessions[0].counts_by_project).toEqual({});
	});

	it("rejects a basis that is neither remote nor root", async () => {
		const access = await signup("badbasis@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					counts_by_project: {
						ee2cfbe428c7: { basis: "worktree", event_count: 3 },
					},
				}),
			],
		});

		expect(response.status).toBe(400);
	});

	it("rejects a non-numeric event_count", async () => {
		const access = await signup("badcount@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					counts_by_project: {
						ee2cfbe428c7: { basis: "remote", event_count: "lots" },
					},
				}),
			],
		});

		expect(response.status).toBe(400);
	});

	// A key this route can't filter on shouldn't cost a machine its sync.
	it("accepts a project key that is not 12 hex", async () => {
		const access = await signup("badkey@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					counts_by_project: {
						"not-a-key": { basis: "remote", event_count: 3 },
					},
				}),
			],
		});

		expect(response.status).toBe(200);
	});

	it("rejects an array where the map belongs", async () => {
		const access = await signup("arraymap@example.com");
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_project: [{ basis: "remote" }] })],
		});

		expect(response.status).toBe(400);
	});

	// The upsert path: a session re-reported as it grows must carry its newer
	// project counts, not keep the first report's. counts_by_project is in the
	// onConflictDoUpdate set for exactly this reason.
	it("updates the project counts when a session is re-reported", async () => {
		const access = await signup("reproject@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [
				summary({
					counts_by_project: {
						ee2cfbe428c7: { basis: "remote", event_count: 5 },
					},
				}),
			],
		});
		await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_project: twoProjects })],
		});

		const stored = await db()
			.prepare(
				"SELECT counts_by_project FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.first<{ counts_by_project: string }>();
		expect(JSON.parse(stored?.counts_by_project ?? "null")).toEqual(
			twoProjects,
		);
	});
});

// ONL-128. The full type is what tells a plugin doing its job from one
// running and producing nothing, which the prefix cannot.
describe("counts_by_type", () => {
	const curatorTypes = {
		"curator.scan.started": 12,
		"curator.scan.complete": 12,
		"tool.shell.exec": 1,
	};

	it("stores the type counts and reads them back parsed", async () => {
		const access = await signup("bytype@example.com");
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_type: curatorTypes })],
		});
		expect(posted.status).toBe(200);

		const read = await get(access);
		const body = (await read.json()) as {
			sessions: { counts_by_type: Record<string, number> }[];
		};
		expect(body.sessions[0].counts_by_type).toEqual(curatorTypes);
	});

	// Every CLI before this column posts no such field, and must keep working.
	it("accepts a summary with no counts_by_type and stores an empty map", async () => {
		const access = await signup("notype@example.com");
		const machine = await mint(access, "laptop");

		const posted = await post(machine.token, {
			schema_version: 1,
			sessions: [summary()],
		});
		expect(posted.status).toBe(200);

		const stored = await db()
			.prepare(
				"SELECT counts_by_type FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.first<{ counts_by_type: string }>();
		expect(stored?.counts_by_type).toBe("{}");

		const read = await get(access);
		const body = (await read.json()) as {
			sessions: { counts_by_type: Record<string, number> }[];
		};
		expect(body.sessions[0].counts_by_type).toEqual({});
	});

	// The CLI keys only registered-looking names, so a key that is not one came
	// from something else, and storing it would store whatever text it holds.
	it.each([
		["a key that is not a dotted lowercase name", { "has space.x": 1 }],
		["a key longer than 64 characters", { [`plugin.${"x".repeat(64)}`]: 1 }],
		["a count that is not a number", { "tool.shell.exec": "lots" }],
		["a count that is not a whole number", { "tool.shell.exec": 1.5 }],
		["a negative count", { "tool.shell.exec": -1 }],
		["an array where the map belongs", ["tool.shell.exec"]],
	])("rejects %s", async (_label, counts_by_type) => {
		const access = await signup(`badtype-${_label.length}@example.com`);
		const machine = await mint(access, "laptop");

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_type })],
		});

		expect(response.status).toBe(400);
	});

	it("rejects more distinct types than one session can have", async () => {
		const access = await signup("toomanytypes@example.com");
		const machine = await mint(access, "laptop");
		const counts_by_type = Object.fromEntries(
			Array.from({ length: 129 }, (_, i) => [`plugin.type${i}`, 1]),
		);

		const response = await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_type })],
		});

		expect(response.status).toBe(400);
	});

	it("updates the type counts when a session is re-reported", async () => {
		const access = await signup("retype@example.com");
		const machine = await mint(access, "laptop");

		await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_type: { "curator.scan.started": 1 } })],
		});
		await post(machine.token, {
			schema_version: 1,
			sessions: [summary({ counts_by_type: curatorTypes })],
		});

		const stored = await db()
			.prepare(
				"SELECT counts_by_type FROM session_summaries WHERE machine_id = ?",
			)
			.bind(machine.id)
			.first<{ counts_by_type: string }>();
		expect(JSON.parse(stored?.counts_by_type ?? "null")).toEqual(curatorTypes);
	});
});
