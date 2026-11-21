import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sessions } from "./fixtures";
import { runSeed, type SeedDeps } from "./seed";

const BASE = "https://api.onlooker.dev";
const NOW = new Date();

function deps(now = NOW): SeedDeps {
	return {
		now,
		exec: async (statements) => {
			await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
		},
		request: (path, init) =>
			exports.default.fetch(`${BASE}${path}`, {
				method: init.method,
				headers: {
					"Content-Type": "application/json",
					...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
	};
}

async function rows<T>(sql: string): Promise<T[]> {
	return (await env.DB.prepare(sql).all<T>()).results;
}

async function count(sql: string): Promise<number> {
	return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

// The whole seed, in-process: its SQL against the migrated schema and every
// push through the real worker. A fixture ingest would refuse fails here, in
// CI, rather than on someone's first `pnpm seed:dev`.
describe("runSeed", () => {
	it("seeds every view's data through real ingest", async () => {
		const result = await runSeed(deps());

		expect(result.email).toBe("dev@onlooker.test");
		expect(result.invitePath).toMatch(/^\/orgs\/invites\/[0-9a-f]{64}$/);

		expect(
			await count(
				"SELECT COUNT(*) AS n FROM session_summaries WHERE user_id = 'seed-user-dev'",
			),
		).toBe(sessions(NOW).length);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM session_projects WHERE user_id = 'seed-user-dev'",
			),
		).toBeGreaterThan(0);

		const statuses = await rows<{ status: string }>(
			"SELECT DISTINCT status FROM lessons WHERE user_id = 'seed-user-dev'",
		);
		expect(new Set(statuses.map((r) => r.status))).toEqual(
			new Set(["active", "refuted", "superseded", "retracted"]),
		);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM lessons WHERE org_id = 'seed-org'",
			),
		).toBe(4);

		const machinesAfter = await rows<{
			id: string;
			revoked_at: string | null;
			removed_at: string | null;
			last_used_at: string | null;
			inventory: string | null;
		}>(
			"SELECT id, revoked_at, removed_at, last_used_at, inventory FROM machine_tokens WHERE id LIKE 'seed-%'",
		);
		const byId = new Map(machinesAfter.map((m) => [m.id, m]));
		expect(byId.get("seed-spare")?.last_used_at).toBeNull();
		expect(byId.get("seed-old-laptop")?.revoked_at).not.toBeNull();
		expect(byId.get("seed-old-laptop")?.removed_at).toBeNull();
		expect(byId.get("seed-old-desktop")?.removed_at).not.toBeNull();
		expect(byId.get("seed-desktop")?.inventory).not.toBeNull();

		// Activity reads seq order; backdating must keep it in time order.
		const feed = await rows<{ at: string }>(
			"SELECT at FROM lesson_feed WHERE user_id = 'seed-user-dev' ORDER BY seq",
		);
		expect(feed).toHaveLength(12);
		expect(feed.map((r) => r.at)).toEqual([...feed.map((r) => r.at)].sort());
	});

	it("logs in with the printed password", async () => {
		const result = await runSeed(deps());
		const login = await exports.default.fetch(`${BASE}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: result.email, password: result.password }),
		});
		expect(login.status).toBe(200);
	});

	it("gives the same rows on a second run, and leaves other accounts alone", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash) VALUES ('bystander', 'bystander@example.com', 'x')",
		).run();
		await runSeed(deps());
		const first = await count(
			"SELECT COUNT(*) AS n FROM lessons WHERE user_id LIKE 'seed-%'",
		);
		await runSeed(deps(new Date(NOW.getTime() + 3_600_000)));

		expect(
			await count(
				"SELECT COUNT(*) AS n FROM lessons WHERE user_id LIKE 'seed-%'",
			),
		).toBe(first);
		expect(
			await count("SELECT COUNT(*) AS n FROM users WHERE id = 'bystander'"),
		).toBe(1);
	});

	it("stops, naming the endpoint, when a push is refused", async () => {
		const failing = deps();
		const refuse: SeedDeps = {
			...failing,
			request: async (path, init) =>
				path === "/machine/sessions"
					? new Response('{"error":"nope"}', { status: 400 })
					: failing.request(path, init),
		};
		await expect(runSeed(refuse)).rejects.toThrow(
			/POST \/machine\/sessions.*400.*nope/,
		);
	});
});
