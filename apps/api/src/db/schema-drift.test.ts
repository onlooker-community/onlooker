import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs script has no type declarations; it must stay
// directly runnable by node in CI, so it is not rewritten in TypeScript.
import { diffSchema } from "../../../../packages/db/scripts/diff-schema.mjs";
import { EXPECTED_SCHEMA } from "../../../../packages/db/src/expected-schema.js";

/**
 * The deploy's schema check, run before merge (ONL-199).
 *
 * `verify-schema` compares expected-schema.ts with the live database, and
 * only at deploy time. Before merge, expected-schema.ts was only ever
 * compared with drizzle's own declaration, which agrees with itself. What
 * the MIGRATIONS build was compared with nothing until a deploy applied
 * them.
 *
 * That gap let 0017 through: drizzle-kit writes a composite primary key's
 * columns sorted by name, so the migration's key order differed from the
 * declaration's, and staging's deploy failed after the migration had
 * already run. This database is built by the same migrations, so the same
 * diffSchema over it fails here instead.
 */

const IGNORED = (name: string) =>
	name.startsWith("sqlite_") ||
	name.startsWith("_cf_") ||
	name === "d1_migrations";

// Interpolated, not bound: PRAGMA statements take no bound parameters in
// SQLite. Safe only because every name below comes from sqlite_master,
// never from input.
async function pragma<T>(sql: string): Promise<T[]> {
	return (await env.DB.prepare(sql).all<T>()).results;
}

/** The shape readLiveSchema builds from a remote database, built locally. */
async function migratedSchema(): Promise<Record<string, unknown>> {
	const tables = (
		await pragma<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table'",
		)
	)
		.map((r) => r.name)
		.filter((n) => !IGNORED(n));

	const schema: Record<string, unknown> = {};
	for (const table of tables) {
		const columns = await pragma<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>(`PRAGMA table_info(${table})`);
		const indexes = (
			await pragma<{ name: string; unique: number }>(
				`PRAGMA index_list(${table})`,
			)
		).filter((r) => !r.name.startsWith("sqlite_"));

		schema[table] = {
			columns: columns.map((c) => ({
				name: c.name,
				type: c.type.toUpperCase(),
				notnull: c.notnull,
				pk: c.pk,
			})),
			indexes: await Promise.all(
				indexes
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(async (r) => ({
						name: r.name,
						unique: Boolean(r.unique),
						columns: (
							await pragma<{ seqno: number; name: string }>(
								`PRAGMA index_info(${r.name})`,
							)
						)
							.sort((a, b) => a.seqno - b.seqno)
							.map((c) => c.name),
					})),
			),
		};
	}
	return schema;
}

describe("the migrations", () => {
	it("build exactly the schema the deploy will verify", async () => {
		expect(diffSchema(EXPECTED_SCHEMA, await migratedSchema())).toEqual([]);
	});
});
