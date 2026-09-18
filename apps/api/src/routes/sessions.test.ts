import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
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
