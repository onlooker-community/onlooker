import type { D1Database } from "@cloudflare/workers-types";
import { sessions, users } from "@onlooker/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

export interface User {
	id: string;
	email: string;
	password_hash: string;
	name?: string;
	// ISO 8601 timestamp of verification, or null when unverified.
	email_verified: string | null;
	created_at: string;
	updated_at: string;
}

export interface RefreshToken {
	id: string;
	user_id: string;
	token_hash: string;
	expires_at: string;
	created_at: string;
}

/**
 * The drizzle client is constructed per call rather than passed in, so these
 * signatures stay identical to the raw-D1 versions they replaced. That keeps
 * every call site in routes/auth.ts untouched and keeps the characterization
 * tests meaningful across this rewrite. Construction is a thin wrapper over
 * the binding, not a connection.
 */
const client = (db: D1Database) => drizzle(db);

/**
 * Create a new user in the database
 */
export async function createUser(
	db: D1Database,
	email: string,
	passwordHash: string,
	name?: string,
): Promise<{ id: string; email: string; name?: string }> {
	const userId = crypto.randomUUID();
	const now = new Date().toISOString();

	await client(db)
		.insert(users)
		.values({
			id: userId,
			email,
			password_hash: passwordHash,
			name: name ?? null,
			email_verified: null,
			created_at: now,
			updated_at: now,
		});

	return { id: userId, email, name };
}

/**
 * Get user by email address
 */
export async function getUserByEmail(
	db: D1Database,
	email: string,
): Promise<User | null> {
	const [row] = await client(db)
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	return (row as User) ?? null;
}

/**
 * Get user by ID
 */
export async function getUserById(
	db: D1Database,
	userId: string,
): Promise<Omit<User, "password_hash"> | null> {
	const [row] = await client(db)
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			email_verified: users.email_verified,
			created_at: users.created_at,
			updated_at: users.updated_at,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	return (row as Omit<User, "password_hash">) ?? null;
}

/**
 * Store a refresh token
 */
export async function storeRefreshToken(
	db: D1Database,
	userId: string,
	token: string,
	expiresAt: Date,
): Promise<void> {
	await client(db)
		.insert(sessions)
		.values({
			id: crypto.randomUUID(),
			user_id: userId,
			token_hash: await hashToken(token),
			expires_at: expiresAt.toISOString(),
			created_at: new Date().toISOString(),
		});
}

/**
 * Get refresh token
 */
export async function getRefreshToken(
	db: D1Database,
	token: string,
): Promise<{ user_id: string; expires_at: string } | null> {
	const [row] = await client(db)
		.select({ user_id: sessions.user_id, expires_at: sessions.expires_at })
		.from(sessions)
		.where(eq(sessions.token_hash, await hashToken(token)))
		.limit(1);

	if (!row) return null;

	// Expiry is checked here rather than in SQL because expires_at is an ISO
	// string, so a SQL comparison would be lexicographic. Same behavior as the
	// raw-D1 version: an expired token reads as absent but its row remains.
	if (new Date(row.expires_at) < new Date()) return null;

	return { user_id: row.user_id, expires_at: row.expires_at };
}

/**
 * Revoke (delete) a refresh token
 */
export async function revokeRefreshToken(
	db: D1Database,
	token: string,
): Promise<void> {
	await client(db)
		.delete(sessions)
		.where(eq(sessions.token_hash, await hashToken(token)));
}

/**
 * SHA-256 of the raw token. Sessions store only this.
 */
async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
