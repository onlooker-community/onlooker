import { env } from "cloudflare:test";
import { session_projects } from "@onlooker/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { client } from "./client.js";

/**
 * How SQLite finds one session's session_projects rows.
 *
 * The primary key leads with (machine_id, project_key), so it cannot serve a
 * lookup by (machine_id, session_id). Both putSessionSummaries' per-sync
 * DELETE and the cascade from session_summaries make that lookup; without
 * session_projects_session_idx each scans every row the machine has. A
 * correctness test cannot see that, so this one reads the plan.
 *
 * The statement is built with the same drizzle expression putSessionSummaries
 * uses, and its SQL is read back with toSQL() rather than retyped.
 */
describe("the session_projects lookup by session", () => {
	it("uses session_projects_session_idx for the sync's delete", async () => {
		const { sql, params } = client(env.DB)
			.delete(session_projects)
			.where(
				and(
					eq(session_projects.machine_id, "m1"),
					eq(session_projects.session_id, "s1"),
				),
			)
			.toSQL();

		const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.bind(...params)
			.all<{ detail: string }>();
		const plan = (results ?? []).map((row) => row.detail);

		expect(plan.join("\n")).toContain("session_projects_session_idx");
	});
});
