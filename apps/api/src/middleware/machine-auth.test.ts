import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createMachineToken,
	revokeMachineToken,
} from "../db/machine-tokens.js";
import { dispatch } from "../router.js";
import { BASE } from "../test-support/lessons.js";
import { resetOrgTables, signup } from "../test-support/orgs.js";
import type { WorkerEnv } from "../types";

/**
 * ONL-223: the router verifies a machine token before the handler runs, and
 * the handlers that need `machineId` used to verify it again, so each request
 * read `machine_tokens` twice and wrote `last_used_at` twice.
 *
 * Dispatched directly rather than over HTTP, because the count has to come
 * from a D1 handle this suite can watch, and `exports.default.fetch` uses the
 * real binding.
 */

beforeEach(async () => {
	await resetOrgTables();
	await env.DB.prepare("DELETE FROM machine_tokens").run();
});

/** An env whose D1 records the SQL of every statement prepared through it. */
function watched(): { env: WorkerEnv; sqls: string[] } {
	const sqls: string[] = [];
	const DB = new Proxy(env.DB, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (query: string) => {
					sqls.push(query);
					return target.prepare(query);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as D1Database;
	return { env: { ...(env as unknown as WorkerEnv), DB }, sqls };
}

const reads = (sqls: string[]) =>
	sqls.filter((sql) => /^select\b[\s\S]*\bmachine_tokens\b/i.test(sql)).length;
// `last_used_at` rather than any update: PUT /machine/inventory stores its
// document on the machine_tokens row too, and that write is the route's job.
const writes = (sqls: string[]) =>
	sqls.filter((sql) => /^update\b[\s\S]*\blast_used_at\b/i.test(sql)).length;

async function machineToken(): Promise<string> {
	const ada = await signup("ada@example.com");
	return (await createMachineToken(env.DB, ada.id, "laptop")).token;
}

function request(
	method: string,
	path: string,
	token: string,
	body?: unknown,
): Request {
	return new Request(`${BASE}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
	{
		method: "PUT",
		path: "/machine/inventory",
		body: {
			schema_version: 1,
			collected_at: "2026-11-16T00:00:00.000Z",
			project: "~/src/onlooker",
			plugins: [],
		},
	},
	{
		method: "POST",
		path: "/machine/sessions",
		body: { schema_version: 1, sessions: [] },
	},
	{
		method: "PUT",
		path: "/machine/project-labels",
		body: { derivation: 1, labels: [] },
	},
	{ method: "DELETE", path: "/machine/project-labels" },
];

describe("a machine route verifies its credential once", () => {
	for (const route of ROUTES) {
		it(`${route.method} ${route.path}`, async () => {
			const token = await machineToken();
			const probe = watched();

			const response = await dispatch(
				request(route.method, route.path, token, route.body),
				probe.env,
			);

			// The handler has to have run, or a count of one proves nothing about
			// the second verification it used to make.
			expect(response.status).toBe(200);
			expect(reads(probe.sqls)).toBe(1);
			expect(writes(probe.sqls)).toBe(1);
		});
	}
});

describe("the remembered verification", () => {
	// The reuse is per request, not per token: a token revoked between two
	// requests must be refused by the second, not answered from the first.
	it("does not outlive its request", async () => {
		const token = await machineToken();
		const route = ROUTES[0];
		if (!route) throw new Error("no route");

		const first = await dispatch(
			request(route.method, route.path, token, route.body),
			env as unknown as WorkerEnv,
		);
		expect(first.status).toBe(200);

		const { results } = await env.DB.prepare(
			"SELECT id, user_id FROM machine_tokens",
		).all<{ id: string; user_id: string }>();
		const row = results[0];
		if (!row) throw new Error("no token row");
		await revokeMachineToken(env.DB, row.user_id, row.id);

		const second = await dispatch(
			request(route.method, route.path, token, route.body),
			env as unknown as WorkerEnv,
		);
		expect(second.status).toBe(401);
	});
});
