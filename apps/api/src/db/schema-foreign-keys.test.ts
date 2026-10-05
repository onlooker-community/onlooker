import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Foreign-key actions, read from a database built by the real migrations.
 *
 * Lives here rather than beside `schema.ts` because `schema.ts`'s own
 * declaration, drizzle-kit's `meta/0011_snapshot.json`, and the SQL that
 * actually runs disagreed once already, silently: drizzle-kit v0.22.8's
 * ALTER-TABLE-ADD-COLUMN generator wrote `REFERENCES orgs(id)` with no
 * `ON DELETE` clause at all, dropping the `onDelete: "set null"` that both
 * `schema.ts` and the snapshot still recorded correctly. Nothing caught it:
 * `packages/db`'s suite reads drizzle's in-memory table config, which only
 * ever agreed with itself, and
 * `packages/db/scripts/generate-expected-schema.mjs` records column names,
 * types and nullability plus index shape, but no foreign-key action at all
 * (see `describe()` in that file). A drift check that doesn't look at a
 * property can't flag it going missing.
 *
 * `PRAGMA foreign_key_list` is SQLite's own account of what a CREATE/ALTER
 * actually committed, independent of drizzle's metadata, so this is the one
 * place a future regenerated migration disagreeing with `schema.ts` again
 * would be caught.
 */

interface ForeignKeyRow {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string;
	on_update: string;
	on_delete: string;
	match: string;
}

async function orgForeignKey(
	table: string,
): Promise<ForeignKeyRow | undefined> {
	// Interpolated, not bound: PRAGMA statements take no bound parameters at
	// all in SQLite, so .bind() isn't an option here. Safe only because both
	// callers below pass a hardcoded table name - never do this with input
	// that didn't originate in this file.
	const { results } = await env.DB.prepare(
		`PRAGMA foreign_key_list(${table})`,
	).all<ForeignKeyRow>();
	return results.find((row) => row.from === "org_id" && row.table === "orgs");
}

describe("the org_id foreign keys", () => {
	// Declares, not observes: this reads PRAGMA foreign_key_list, which
	// reports what the schema says will happen, not a row actually going
	// null. orgs-schema.test.ts's "cascades memberships when the org goes"
	// is the test that inserts, deletes and watches a row change; this one
	// is the layer below that would have caught the generator dropping the
	// action in the first place.
	it("declares ON DELETE SET NULL for lessons.org_id", async () => {
		const fk = await orgForeignKey("lessons");
		expect(fk?.on_delete).toBe("SET NULL");
	});

	it("declares ON DELETE SET NULL for machine_tokens.org_id", async () => {
		const fk = await orgForeignKey("machine_tokens");
		expect(fk?.on_delete).toBe("SET NULL");
	});
});
