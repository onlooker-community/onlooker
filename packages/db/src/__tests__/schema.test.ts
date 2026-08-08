import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { sessions, users, verification_tokens } from "../schema.js";

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table)
		.columns.map((c) => c.name)
		.sort();

const indexNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table)
		.indexes.map((i) => i.config.name)
		.sort();

describe("users", () => {
	it("declares exactly the columns apps/api queries", () => {
		expect(columnNames(users)).toEqual([
			"created_at",
			"email",
			"email_verified",
			"id",
			"name",
			"password_hash",
			"updated_at",
		]);
	});

	it("keeps email unique", () => {
		const idx = getTableConfig(users).indexes.find(
			(i) => i.config.name === "users_email_idx",
		);
		expect(idx?.config.unique).toBe(true);
	});

	it("allows email_verified to be null, meaning unverified", () => {
		const col = getTableConfig(users).columns.find(
			(c) => c.name === "email_verified",
		);
		expect(col?.notNull).toBe(false);
	});
});

describe("sessions", () => {
	it("stores a token hash, not a token", () => {
		expect(columnNames(sessions)).toContain("token_hash");
		expect(columnNames(sessions)).not.toContain("token");
	});

	// Production had lost this constraint; two sessions sharing a token hash
	// is a defect, so it is asserted rather than assumed.
	it("keeps token_hash unique", () => {
		const idx = getTableConfig(sessions).indexes.find(
			(i) => i.config.name === "sessions_token_hash_idx",
		);
		expect(idx?.config.unique).toBe(true);
	});

	it("cascades when its user is deleted", () => {
		const fk = getTableConfig(sessions).foreignKeys[0];
		expect(fk.onDelete).toBe("cascade");
	});
});

describe("verification_tokens", () => {
	it("is one table carrying a type discriminator", () => {
		expect(columnNames(verification_tokens)).toEqual([
			"created_at",
			"expires_at",
			"id",
			"token",
			"type",
			"user_id",
		]);
		expect(indexNames(verification_tokens)).toContain(
			"verification_tokens_type_idx",
		);
	});
});

describe("the schema as a whole", () => {
	// The deferred tables are deferred on purpose. If one reappears, it should
	// arrive with the feature that needs it, not by accident.
	it("declares only the three tables in use", async () => {
		const schema = await import("../schema.js");
		// is(v, SQLiteTable) rather than "_" in v: drizzle-orm moved table
		// metadata behind a symbol in 0.31, so the string key no longer matches.
		const tables = Object.values(schema).filter((v) => is(v, SQLiteTable));
		expect(tables).toHaveLength(3);
	});
});
