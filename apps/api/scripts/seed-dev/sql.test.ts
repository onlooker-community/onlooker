import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { invites, lessonTimeline, machines } from "./fixtures";
import { afterSql, baseSql, resetSql } from "./sql";

const NOW = new Date("2026-11-20T15:00:00.000Z");

function input() {
	return {
		now: NOW,
		passwordHash: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhashnot",
		tokenHashes: Object.fromEntries(
			machines(NOW).map((m) => [m.id, `hash-${m.id}`]),
		),
		inviteHashes: Object.fromEntries(
			invites(NOW).map((i) => [i.id, `hash-${i.id}`]),
		),
	};
}

async function run(statements: string[]) {
	await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function count(sql: string): Promise<number> {
	const row = await env.DB.prepare(sql).first<{ n: number }>();
	return row?.n ?? 0;
}

describe("the seed's SQL", () => {
	it("deletes only seed accounts and seed orgs", () => {
		expect(resetSql()).toEqual([
			"DELETE FROM users WHERE email LIKE '%@onlooker.test';",
			"DELETE FROM orgs WHERE id LIKE 'seed-%';",
		]);
	});

	it("writes the base rows into the real schema", async () => {
		await run(resetSql());
		await run(baseSql(input()));

		expect(
			await count(
				"SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@onlooker.test'",
			),
		).toBe(3);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = 'seed-org'",
			),
		).toBe(2);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM org_invites WHERE org_id = 'seed-org'",
			),
		).toBe(2);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE id LIKE 'seed-%'",
			),
		).toBe(7);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM project_labels WHERE user_id = 'seed-user-dev'",
			),
		).toBe(6);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM machine_tokens WHERE org_id = 'seed-org'",
			),
		).toBe(2);
	});

	it("can run twice, replacing its own rows and leaving other accounts alone", async () => {
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash) VALUES ('other-user', 'other@example.com', 'x')",
		).run();
		await run(resetSql());
		await run(baseSql(input()));
		await run(resetSql());
		await run(baseSql(input()));

		expect(
			await count(
				"SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@onlooker.test'",
			),
		).toBe(3);
		expect(
			await count("SELECT COUNT(*) AS n FROM users WHERE id = 'other-user'"),
		).toBe(1);
	});

	it("escapes quotes in names", () => {
		expect(baseSql(input()).join("\n")).toContain("'ada''s laptop'");
	});

	it("retires machines and backdates the feed after the pushes", () => {
		const after = afterSql(NOW, lessonTimeline(NOW)).join("\n");
		expect(after).toContain("UPDATE machine_tokens SET revoked_at");
		expect(after).toContain("removed_at");
		expect(after).toContain("UPDATE lesson_feed SET at");
		// The never-used machine keeps last_used_at NULL.
		expect(after).not.toMatch(/last_used_at = '[^']+' WHERE id = 'seed-spare'/);
	});
});
