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
	login_attempts,
	machine_tokens,
	mail_sends,
	project_labels,
	session_summaries,
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
			"anonymized_at",
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
			// The reported inventory and when it landed. A document rather
			// than a machine_plugins table: the server never reads inside it.
			"inventory",
			"inventory_at",
			"last_used_at",
			"name",
			// The org this token pushes to, or null for a private-only token.
			"org_id",
			// When the owner deleted a revoked machine from the Machines page.
			"removed_at",
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
			"author_key",
			"body",
			"created_at",
			"id",
			// The org this lesson was shared with, or null.
			"org_id",
			"promoted_at",
			"schema_version",
			"status",
			"updated_at",
			"user_id",
			"visibility",
		]);
	});

	// The third column is the keyset tiebreak. Two lessons promoted in the same
	// millisecond make a cursor on promoted_at alone ambiguous, and a page
	// boundary that lands between them can skip or repeat a row. Ordering by
	// (promoted_at, id) is what makes the cursor stable; carrying id in the
	// index is what keeps that comparison off the table.
	it("indexes (user_id, promoted_at, id) so the cursor is stable", () => {
		const idx = getTableConfig(lessons).indexes.find(
			(i) => i.config.name === "lessons_user_promoted_at_idx",
		);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual([
			"user_id",
			"promoted_at",
			"id",
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

describe("session_summaries", () => {
	it("declares exactly the columns a session's feed row needs", () => {
		expect(columnNames(session_summaries)).toEqual([
			"compactions",
			"counts_by_prefix",
			"counts_by_project",
			"counts_by_type",
			"ended_at",
			"event_count",
			"machine_id",
			"plugins",
			"prompts",
			"reported_at",
			"session_id",
			"started_at",
			"user_id",
		]);
	});

	it("cascades when its user or machine is deleted", () => {
		const fks = getTableConfig(session_summaries).foreignKeys;
		expect(fks).toHaveLength(2);
		for (const fk of fks) {
			expect(fk.onDelete).toBe("cascade");
		}
	});

	// Keyed on (machine_id, session_id) rather than an id of its own - the CLI
	// re-reports a session as it grows, and upserting on this key is what lets
	// a still-running session (null ended_at) get replaced instead of
	// duplicated on the next sync.
	it("is keyed on (machine_id, session_id), not its own id", () => {
		const pks = getTableConfig(session_summaries).primaryKeys;
		expect(pks).toHaveLength(1);
		expect(indexColumnNames(pks[0].columns)).toEqual([
			"machine_id",
			"session_id",
		]);
	});

	it("allows ended_at to be null, meaning still running", () => {
		const col = getTableConfig(session_summaries).columns.find(
			(c) => c.name === "ended_at",
		);
		expect(col?.notNull).toBe(false);
	});

	// The feed's only query: this user's sessions, newest first.
	it("indexes (user_id, started_at) for the feed query", () => {
		const idx = getTableConfig(session_summaries).indexes.find(
			(i) => i.config.name === "session_summaries_user_started_idx",
		);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual([
			"user_id",
			"started_at",
		]);
	});
});

describe("project_labels", () => {
	it("declares exactly the columns a label needs", () => {
		expect(columnNames(project_labels)).toEqual([
			"label",
			"machine_id",
			"project_key",
			"source",
			"updated_at",
			"user_id",
		]);
	});

	// Source is in the key so a label the CLI uploads (ONL-197) sits beside
	// the user's own instead of overwriting it.
	//
	// In name order, the order drizzle-kit writes a composite key in. Any
	// other declared order makes expected-schema.ts disagree with the
	// migration it describes (ONL-199).
	it("is keyed on (machine_id, project_key, source, user_id)", () => {
		const pks = getTableConfig(project_labels).primaryKeys;
		expect(pks).toHaveLength(1);
		expect(indexColumnNames(pks[0].columns)).toEqual([
			"machine_id",
			"project_key",
			"source",
			"user_id",
		]);
	});

	// Not null, because SQLite treats every NULL in a primary key as distinct:
	// a nullable machine_id would let one remote key carry two labels.
	it("stores a remote key's missing machine as '', not null", () => {
		const col = getTableConfig(project_labels).columns.find(
			(c) => c.name === "machine_id",
		);
		expect(col?.notNull).toBe(true);
	});

	// Only the user. machine_id holds '' for a remote key, which no
	// machine_tokens row has, so it cannot be a foreign key - and anonymization
	// keeps the users row, so this cascade is not what removes labels either.
	// queries.ts deletes them explicitly.
	// drizzle-kit emits a composite key's columns sorted by name, so the
	// stored key leads with machine_id and cannot serve the only read: all of
	// one user's labels.
	it("indexes user_id for the read, which the sorted key cannot serve", () => {
		const idx = getTableConfig(project_labels).indexes.find(
			(i) => i.config.name === "project_labels_user_idx",
		);
		expect(indexColumnNames(idx?.config.columns ?? [])).toEqual(["user_id"]);
	});

	it("references only its user", () => {
		const fks = getTableConfig(project_labels).foreignKeys;
		expect(fks).toHaveLength(1);
		expect(fks[0].onDelete).toBe("cascade");
	});
});

describe("the schema as a whole", () => {
	// The deferred tables are deferred on purpose. If one reappears, it should
	// arrive with the feature that needs it, not by accident. Fourteen, as of
	// mail_sends landing with the mail cap (ONL-222); thirteen before that, as
	// of project_labels landing with repository aliases (ONL-189); twelve before
	// that, as of login_attempts landing with the failed-login backoff
	// (onlooker-9s0m); eleven before that, since orgs/org_memberships/
	// org_invites arrived with org accounts (ONL-12).
	it("declares only the fourteen tables in use", async () => {
		const schema = await import("../schema.js");
		// is(v, SQLiteTable) rather than "_" in v: drizzle-orm moved table
		// metadata behind a symbol in 0.31, so the string key no longer matches.
		const tables = Object.values(schema).filter((v) => is(v, SQLiteTable));
		expect(tables).toHaveLength(14);
	});
});

describe("the org lesson tier's columns", () => {
	it("gives lessons a nullable org_id", () => {
		const column = getTableConfig(lessons).columns.find(
			(c) => c.name === "org_id",
		);
		expect(column).toBeDefined();
		expect(column?.getSQLType().toUpperCase()).toBe("TEXT");
		// Nullable is the point, not an oversight: a private or public lesson
		// has no org, and SQLite cannot add a NOT NULL column without a
		// default to a table that already exists.
		expect(column?.notNull).toBe(false);
	});

	it("gives machine_tokens a nullable org_id", () => {
		const column = getTableConfig(machine_tokens).columns.find(
			(c) => c.name === "org_id",
		);
		expect(column).toBeDefined();
		expect(column?.getSQLType().toUpperCase()).toBe("TEXT");
		// Null means a private-only token, which is what every token minted
		// before this change is.
		expect(column?.notNull).toBe(false);
	});
});

describe("login_attempts", () => {
	it("declares exactly the three columns the backoff reads", () => {
		expect(columnNames(login_attempts)).toEqual([
			"fails",
			"key",
			"last_fail_at",
		]);
	});

	// A stored deadline would be a second source of truth for a fact
	// cooldownFor already derives, and a change to the curve would silently
	// leave rows behind on the old schedule.
	it("stores no deadline", () => {
		expect(columnNames(login_attempts)).not.toContain("locked_until");
	});

	it("keys on the hash, so a row costs one point read", () => {
		const column = getTableConfig(login_attempts).columns.find(
			(c) => c.name === "key",
		);
		expect(column?.primary).toBe(true);
	});

	// The prune is the one query that does not go through the primary key.
	it("indexes the column the prune scans", () => {
		expect(indexNames(login_attempts)).toEqual([
			"login_attempts_last_fail_at_idx",
		]);
		const index = getTableConfig(login_attempts).indexes[0];
		expect(indexColumnNames(index.config.columns)).toEqual(["last_fail_at"]);
	});
});

describe("mail_sends", () => {
	it("declares exactly the three columns the mail cap reads", () => {
		expect(columnNames(mail_sends)).toEqual(["count", "key", "window_start"]);
	});

	// The key is a hash. A plaintext column would make this table a list of
	// every address anybody asked to have mailed.
	it("stores no address", () => {
		expect(columnNames(mail_sends)).not.toContain("email");
		expect(columnNames(mail_sends)).not.toContain("address");
	});
});
