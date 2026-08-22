import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Users.
 *
 * email_verified holds an ISO 8601 timestamp, or null when unverified. A
 * boolean would record only whether, never when, and the API's own response
 * type (apps/api/src/types/responses.ts) already declares string | null.
 */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		// Uniqueness is declared once, as a named index below. Adding .unique()
		// here as well would make drizzle emit both a UNIQUE constraint and a
		// separate unique index for the same column.
		email: text("email").notNull(),
		password_hash: text("password_hash").notNull(),
		name: text("name"),
		email_verified: text("email_verified"),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		updated_at: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		emailIdx: uniqueIndex("users_email_idx").on(table.email),
		createdAtIdx: index("users_created_at_idx").on(table.created_at),
	}),
);

/**
 * Sessions - refresh tokens, stored hashed.
 *
 * The column is token_hash rather than token because that is what it holds;
 * apps/api SHA-256s the raw token before writing. UNIQUE is deliberate: two
 * sessions sharing a token hash is a defect, and production had lost this
 * constraint.
 */
export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token_hash: text("token_hash").notNull(),
		expires_at: text("expires_at").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		tokenHashIdx: uniqueIndex("sessions_token_hash_idx").on(table.token_hash),
		userIdIdx: index("sessions_user_id_idx").on(table.user_id),
		expiresAtIdx: index("sessions_expires_at_idx").on(table.expires_at),
	}),
);

/**
 * Verification tokens for email verification and password reset.
 *
 * One table with a type discriminator rather than two tables, because the two
 * flows have identical shapes. email_change_tokens will be its own table when
 * that feature lands, since it carries a new_email column these do not.
 *
 * The column holds a SHA-256 of the token, never the token itself, which is why
 * it is named token_hash and matches sessions. A password-reset token is a
 * bearer credential: whoever holds one can take an account over without knowing
 * the password, so a database read should not hand out working reset links.
 * This was `token` in plaintext until the flows were built; nothing had ever
 * written to the table, so the rename cost nothing and the alternative was
 * storing a hash in a column that said otherwise.
 */
export const verification_tokens = sqliteTable(
	"verification_tokens",
	{
		id: text("id").primaryKey(),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token_hash: text("token_hash").notNull(),
		type: text("type").notNull(),
		expires_at: text("expires_at").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => ({
		tokenIdx: uniqueIndex("verification_tokens_token_idx").on(table.token_hash),
		userIdIdx: index("verification_tokens_user_id_idx").on(table.user_id),
		typeIdx: index("verification_tokens_type_idx").on(table.type),
		expiresAtIdx: index("verification_tokens_expires_at_idx").on(
			table.expires_at,
		),
	}),
);

/**
 * Machine tokens - long-lived bearer credentials for non-browser clients.
 *
 * Deliberately not a row in `sessions`. The two look similar and behave
 * differently: a session is a short-lived access token with a rotating refresh,
 * obtained by posting a password, while a machine token is long-lived, never
 * rotates, and never sees a password. Sharing a table would mean every query on
 * it first has to establish which kind of row it holds, and
 * revokeAllSessionsForUserExcept would silently start reaching credentials it
 * was never written for.
 *
 * token_hash holds a SHA-256, matching sessions and verification_tokens. The
 * raw value is returned once at creation and never stored.
 *
 * revoked_at is nullable rather than the row being deleted, so a revoked
 * machine stays visible in the web app - a revocation control nobody can act on
 * because they cannot tell which row is the stolen laptop is a control in name
 * only. last_used_at is what makes that identification possible.
 */
export const machine_tokens = sqliteTable(
	"machine_tokens",
	{
		id: text("id").primaryKey(),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		token_hash: text("token_hash").notNull(),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		last_used_at: text("last_used_at"),
		revoked_at: text("revoked_at"),
	},
	(table) => ({
		tokenHashIdx: uniqueIndex("machine_tokens_token_hash_idx").on(
			table.token_hash,
		),
		userIdIdx: index("machine_tokens_user_id_idx").on(table.user_id),
	}),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type VerificationToken = typeof verification_tokens.$inferSelect;
export type NewVerificationToken = typeof verification_tokens.$inferInsert;

export type MachineToken = typeof machine_tokens.$inferSelect;
export type NewMachineToken = typeof machine_tokens.$inferInsert;
