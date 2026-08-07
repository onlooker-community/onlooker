import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Users table - stores user account information
 *
 * - id: Unique identifier (UUID)
 * - email: User email address (unique, indexed for fast lookups)
 * - password_hash: Bcrypt hashed password
 * - name: User's display name (optional)
 * - created_at: Account creation timestamp (ISO 8601)
 * - email_verified: ISO 8601 timestamp when email was verified, null if unverified
 * - deleted_at: Soft delete timestamp (null = active, set = deleted)
 */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(), // UUID
		email: text("email").notNull().unique(),
		password_hash: text("password_hash").notNull(),
		name: text("name"),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		email_verified: text("email_verified"), // ISO 8601 timestamp
		deleted_at: text("deleted_at"), // Soft delete
	},
	(table) => {
		return {
			emailIdx: uniqueIndex("users_email_idx").on(table.email),
			createdAtIdx: index("users_created_at_idx").on(table.created_at),
			deletedAtIdx: index("users_deleted_at_idx").on(table.deleted_at),
		};
	},
);

/**
 * Sessions table - stores active user sessions
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id
 * - token: Refresh token (hashed, indexed for fast lookups on token validation)
 * - expires_at: Session expiration timestamp (ISO 8601)
 * - created_at: Session creation timestamp (ISO 8601)
 *
 * Refresh tokens are issued during login/signup and used to obtain new access tokens.
 * When a client receives a 401 on a protected resource, it uses the refresh token
 * to get a new access token without requiring re-authentication.
 */
export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull(), // Hashed refresh token
		expires_at: text("expires_at").notNull(), // ISO 8601
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(table) => {
		return {
			userIdIdx: index("sessions_user_id_idx").on(table.user_id),
			expiresAtIdx: index("sessions_expires_at_idx").on(table.expires_at),
			createdAtIdx: index("sessions_created_at_idx").on(table.created_at),
		};
	},
);

/**
 * Email verification tokens table - one-time tokens sent to users during signup
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id
 * - token: Verification token (hashed, indexed for fast lookups)
 * - expires_at: Token expiration timestamp (ISO 8601)
 * - created_at: Token creation timestamp (ISO 8601)
 * - used_at: ISO 8601 timestamp when the token was used, null if unused
 *
 * When a user signs up, they receive an email with a verification link containing
 * this token. They click the link, we verify the token is valid (not expired, not used),
 * then mark it as used and set users.email_verified.
 */
export const email_verification_tokens = sqliteTable(
	"email_verification_tokens",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull(), // Hashed verification token
		expires_at: text("expires_at").notNull(), // ISO 8601
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		used_at: text("used_at"), // ISO 8601 timestamp when verified
	},
	(table) => {
		return {
			userIdIdx: index("email_verification_tokens_user_id_idx").on(
				table.user_id,
			),
			expiresAtIdx: index("email_verification_tokens_expires_at_idx").on(
				table.expires_at,
			),
			usedAtIdx: index("email_verification_tokens_used_at_idx").on(
				table.used_at,
			),
		};
	},
);

/**
 * Password reset tokens table - one-time tokens sent to users requesting password reset
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id
 * - token: Reset token (hashed, indexed for fast lookups)
 * - expires_at: Token expiration timestamp (ISO 8601)
 * - created_at: Token creation timestamp (ISO 8601)
 * - used_at: ISO 8601 timestamp when the token was used, null if unused
 *
 * When a user requests a password reset, they receive an email with a reset link
 * containing this token. They click the link, we verify the token is valid, then
 * they submit their new password. We verify the token again, then update users.password_hash
 * and mark the token as used.
 */
export const password_reset_tokens = sqliteTable(
	"password_reset_tokens",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull(), // Hashed reset token
		expires_at: text("expires_at").notNull(), // ISO 8601
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		used_at: text("used_at"), // ISO 8601 timestamp when reset was completed
	},
	(table) => {
		return {
			userIdIdx: index("password_reset_tokens_user_id_idx").on(table.user_id),
			expiresAtIdx: index("password_reset_tokens_expires_at_idx").on(
				table.expires_at,
			),
			usedAtIdx: index("password_reset_tokens_used_at_idx").on(table.used_at),
		};
	},
);

/**
 * Email change tokens table - one-time tokens for users changing their email address
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id
 * - new_email: The new email address being verified
 * - token: Change token (hashed, indexed for fast lookups)
 * - expires_at: Token expiration timestamp (ISO 8601)
 * - created_at: Token creation timestamp (ISO 8601)
 * - used_at: ISO 8601 timestamp when the token was used, null if unused
 *
 * When a user wants to change their email, they submit a new email address.
 * We send them a verification email to the new address with this token.
 * They click the link, we verify the token is valid, then update users.email
 * and mark the token as used.
 */
export const email_change_tokens = sqliteTable(
	"email_change_tokens",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		new_email: text("new_email").notNull(), // The new email being verified
		token: text("token").notNull(), // Hashed change token
		expires_at: text("expires_at").notNull(), // ISO 8601
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		used_at: text("used_at"), // ISO 8601 timestamp when email was changed
	},
	(table) => {
		return {
			userIdIdx: index("email_change_tokens_user_id_idx").on(table.user_id),
			newEmailIdx: index("email_change_tokens_new_email_idx").on(
				table.new_email,
			),
			expiresAtIdx: index("email_change_tokens_expires_at_idx").on(
				table.expires_at,
			),
			usedAtIdx: index("email_change_tokens_used_at_idx").on(table.used_at),
		};
	},
);

/**
 * Machine tokens table - stores API keys / machine-to-machine authentication tokens
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id (the owner of this machine token)
 * - machine_id: Machine identifier (UUID)
 * - name: Human-readable name for this machine token
 * - token: Hashed machine token (indexed for fast lookups on token validation)
 * - created_at: Token creation timestamp (ISO 8601)
 * - expires_at: Token expiration timestamp (ISO 8601, null = never expires unless revoked)
 * - revoked_at: ISO 8601 timestamp when the token was revoked, null if active
 * - last_used_at: ISO 8601 timestamp of last successful use, null if never used
 *
 * Machine tokens allow programmatic access to the API without user interaction.
 * They're created by users and can be revoked or rotated.
 */
export const machine_tokens = sqliteTable(
	"machine_tokens",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machine_id: text("machine_id").notNull(), // UUID
		name: text("name").notNull(), // e.g., "GitHub CI", "Local Dev"
		token: text("token").notNull(), // Hashed machine token
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		expires_at: text("expires_at"), // ISO 8601, null = no expiration
		revoked_at: text("revoked_at"), // ISO 8601 timestamp when revoked
		last_used_at: text("last_used_at"), // ISO 8601 timestamp
	},
	(table) => {
		return {
			userIdIdx: index("machine_tokens_user_id_idx").on(table.user_id),
			machineIdIdx: index("machine_tokens_machine_id_idx").on(table.machine_id),
			revokedAtIdx: index("machine_tokens_revoked_at_idx").on(table.revoked_at),
		};
	},
);

/**
 * Audit log table - tracks security-relevant events for compliance and debugging
 *
 * - id: Unique identifier (UUID)
 * - user_id: Foreign key to users.id (the user affected by this event, null for system events)
 * - action: The event type (e.g., "user_login", "password_changed", "email_verified", "token_revoked")
 * - resource_type: What was affected (e.g., "session", "password", "email", "machine_token")
 * - resource_id: ID of the affected resource
 * - ip_address: IPv4 or IPv6 address (captured if available, for security analysis)
 * - user_agent: User agent string (captured if available, for security analysis)
 * - created_at: Event timestamp (ISO 8601)
 * - details: Optional JSON metadata about the event
 */
export const audit_logs = sqliteTable(
	"audit_logs",
	{
		id: text("id").primaryKey(), // UUID
		user_id: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: text("action").notNull(), // e.g., "user_login", "password_changed"
		resource_type: text("resource_type"), // e.g., "session", "password", "email"
		resource_id: text("resource_id"), // e.g., session UUID, user UUID
		ip_address: text("ip_address"), // IPv4 or IPv6
		user_agent: text("user_agent"),
		created_at: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
		details: text("details"), // JSON string
	},
	(table) => {
		return {
			userIdIdx: index("audit_logs_user_id_idx").on(table.user_id),
			actionIdx: index("audit_logs_action_idx").on(table.action),
			createdAtIdx: index("audit_logs_created_at_idx").on(table.created_at),
		};
	},
);

/**
 * Type exports for use throughout the application
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type EmailVerificationToken =
	typeof email_verification_tokens.$inferSelect;
export type NewEmailVerificationToken =
	typeof email_verification_tokens.$inferInsert;

export type PasswordResetToken = typeof password_reset_tokens.$inferSelect;
export type NewPasswordResetToken = typeof password_reset_tokens.$inferInsert;

export type EmailChangeToken = typeof email_change_tokens.$inferSelect;
export type NewEmailChangeToken = typeof email_change_tokens.$inferInsert;

export type MachineToken = typeof machine_tokens.$inferSelect;
export type NewMachineToken = typeof machine_tokens.$inferInsert;

export type AuditLog = typeof audit_logs.$inferSelect;
export type NewAuditLog = typeof audit_logs.$inferInsert;
