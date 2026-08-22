import { is } from "drizzle-orm";
import {
	getTableConfig,
	SQLiteColumn,
	SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import {
	lesson_feed,
	lessons,
	machine_tokens,
	sessions,
	users,
	verification_tokens,
} from "../schema.js";

const columnNames = (table: Parameters<typeof getTableConfig>[0]) =>
	getTableConfig(table)
		.columns.map((c) => c.name)
		.sort();

// An index column is either an actual column or a raw SQL expression; every
// index in this schema is declared on real columns, never an expression.
const indexColumnNames = (indexColumns: unknown[]) =>
	indexColumns
		.filter((c): c is SQLiteColumn => is(c, SQLiteColumn))
		.map((c) => c.name);

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
			"token_hash",
			"type",
			"user_id",
		]);
		expect(indexNames(verification_tokens)).toContain(
			"verification_tokens_type_idx",
		);
	});

	// Named token_hash, not token, and the name is the guarantee. A reset token
	// is a bearer credential - whoever holds one can take an account over without
	// knowing the password - so reading this table must not hand out working
	// links. sessions already stores only a hash; this now matches, and a column
	// called `token` would invite the next person to put the real thing in it.
	it("stores a hash rather than the token itself", () => {
		expect(columnNames(verification_tokens)).not.toContain("token");
		expect(columnNames(verification_tokens)).toContain("token_hash");
	});
});

describe("machine_tokens", () => {
	it("declares exactly the columns a machine credential needs", () => {
		expect(columnNames(machine_tokens)).toEqual([
			"created_at",
			"id",
			"last_used_at",
			"name",
			"revoked_at",
			"token_hash",
			"user_id",
		]);
	});

	it("stores a token hash, not a token", () => {
		expect(columnNames(machine_tokens)).toContain("token_hash");
		expect(columnNames(machine_tokens)).not.toContain("token");
	});

	it("keeps token_hash unique", () => {
		const idx = getTableConfig(machine_tokens).indexes.find(
			(i) => i.config.name === "machine_tokens_token_hash_idx",
		);
		expect(idx?.config.unique).toBe(true);
	});

	it("cascades when its user is deleted", () => {
		const fk = getTableConfig(machine_tokens).foreignKeys[0];
		expect(fk.onDelete).toBe("cascade");
	});

	// revoked_at is nullable so a revoked machine stays visible rather than
	// disappearing - the row is what lets someone identify the stolen laptop.
	it("allows revoked_at and last_used_at to be null", () => {
		const columns = getTableConfig(machine_tokens).columns;
		expect(columns.find((c) => c.name === "revoked_at")?.notNull).toBe(false);
		expect(columns.find((c) => c.name === "last_used_at")?.notNull).toBe(false);
	});
});

describe("lessons", () => {
	it("declares exactly the columns the hosted lesson pool needs", () => {
		expect(columnNames(lessons)).toEqual([
			"body",
			"created_at",
			"id",
			"schema_version",
			"status",
			"updated_at",
			"user_id",
			"visibility",
		]);
	});

	it("cascades when its user is deleted", () => {
		const fk = getTableConfig(lessons).foreignKeys[0];
		expect(fk.onDelete).toBe("cascade");
	});

	// A dense sequence and mutable row positions are incompatible: bumping a
	// seq column here on status change would vacate the lesson's old position,
	// so ordering lives in lesson_feed instead. See that table's comment.
	it("has no seq column - ordering lives in lesson_feed", () => {
		expect(columnNames(lessons)).not.toContain("seq");
	});
});

describe("lesson_feed", () => {
	it("declares exactly the columns the append-only feed needs", () => {
		expect(columnNames(lesson_feed)).toEqual([
			"at",
			"kind",
			"lesson_id",
			"seq",
			"user_id",
		]);
	});

	it("cascades when its user or lesson is deleted", () => {
		const fks = getTableConfig(lesson_feed).foreignKeys;
		expect(fks).toHaveLength(2);
		for (const fk of fks) {
			expect(fk.onDelete).toBe("cascade");
		}
	});

	// UNIQUE(user_id, seq) is what makes the per-user counter correct: two
	// racing pushes that compute the same next value collide, and the loser
	// retries. A unique index on seq alone would be wrong - the second user's
	// first lesson would collide with the first user's.
	it("keeps seq unique per user, not globally", () => {
		const idx = getTableConfig(lesson_feed).indexes.find(
			(i) => i.config.name === "lesson_feed_user_seq_idx",
		);
		expect(idx?.config.unique).toBe(true);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual([
			"user_id",
			"seq",
		]);
	});
});

describe("the schema as a whole", () => {
	// The deferred tables are deferred on purpose. If one reappears, it should
	// arrive with the feature that needs it, not by accident.
	it("declares only the six tables in use", async () => {
		const schema = await import("../schema.js");
		// is(v, SQLiteTable) rather than "_" in v: drizzle-orm moved table
		// metadata behind a symbol in 0.31, so the string key no longer matches.
		const tables = Object.values(schema).filter((v) => is(v, SQLiteTable));
		expect(tables).toHaveLength(6);
	});
});
