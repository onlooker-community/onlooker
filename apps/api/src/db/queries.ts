import type { D1Database } from "@cloudflare/workers-types";
import { sessions, users, verification_tokens } from "@onlooker/db";
import { and, eq, ne } from "drizzle-orm";
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

/**
 * Apply a partial profile update.
 *
 * A field absent from `changes` is left alone rather than nulled, which is why
 * this builds the update object instead of spreading `changes` straight in: a
 * PATCH that sends only a name must not erase the address.
 *
 * An empty update still touches nothing and does not error. Callers reach here
 * having already validated shape; "the user changed nothing" is a legitimate
 * request, not a failure.
 */
export async function updateProfile(
	db: D1Database,
	userId: string,
	changes: { name?: string; email?: string },
): Promise<void> {
	const update: Record<string, string> = {};
	if (changes.name !== undefined) update.name = changes.name;
	if (changes.email !== undefined) update.email = changes.email;
	if (Object.keys(update).length === 0) return;

	update.updated_at = new Date().toISOString();

	await client(db).update(users).set(update).where(eq(users.id, userId));
}

/**
 * Mark an address verified, or un-verify it.
 *
 * Stored as a timestamp rather than a flag, so "verified" is the presence of a
 * date and un-verifying is clearing it. The false direction exists because
 * changing an address has to invalidate whatever proof the old one had.
 */
export async function setEmailVerified(
	db: D1Database,
	userId: string,
	verified: boolean,
): Promise<void> {
	await client(db)
		.update(users)
		.set({
			email_verified: verified ? new Date().toISOString() : null,
			updated_at: new Date().toISOString(),
		})
		.where(eq(users.id, userId));
}

/** Whether this account's address has been verified. */
export async function isEmailVerified(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const user = await getUserById(db, userId);
	return user?.email_verified != null;
}

/** Replace the stored password hash. Hashing is the caller's job. */
export async function updatePassword(
	db: D1Database,
	userId: string,
	passwordHash: string,
): Promise<void> {
	await client(db)
		.update(users)
		.set({ password_hash: passwordHash, updated_at: new Date().toISOString() })
		.where(eq(users.id, userId));
}

/**
 * End every session this user holds, on every device.
 *
 * Deletes refresh tokens, which is all a session is here. Access tokens already
 * issued keep working until they expire - see SESSION_LIFECYCLE in
 * packages/api-contract - so this bounds the other devices at the access-token
 * lifetime rather than cutting them off instantly.
 */
export async function revokeAllSessionsForUser(
	db: D1Database,
	userId: string,
): Promise<void> {
	await client(db).delete(sessions).where(eq(sessions.user_id, userId));
}

/**
 * Delete an account.
 *
 * Sessions and verification tokens both declare ON DELETE CASCADE against
 * users, so they go with it and this does not sweep them by hand. queries.test
 * asserts that, because the day the constraint changes is the day a deleted
 * account keeps a working session.
 */
export async function deleteUser(
	db: D1Database,
	userId: string,
): Promise<void> {
	await client(db).delete(users).where(eq(users.id, userId));
}

/**
 * The stored password hash for a user, by id.
 *
 * By id and not by email on purpose. An access token carries an email claim
 * that goes stale the moment its owner edits their address, and
 * change-password is reachable with exactly such a token - looking up by that
 * claim would fail for the one person who most recently used this feature.
 *
 * Separate from getUserById because that one deliberately never selects the
 * hash; this is the single place allowed to, and its return type says so.
 */
export async function getPasswordHash(
	db: D1Database,
	userId: string,
): Promise<string | null> {
	const [row] = await client(db)
		.select({ password_hash: users.password_hash })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	return row?.password_hash ?? null;
}

/**
 * End every session this user holds except the one presenting `keepToken`.
 *
 * For password changes. The point of changing a password is usually that
 * somebody else may know the old one, so the other sessions have to go - but
 * signing out the person who just proved they know both passwords is noise, so
 * theirs is spared.
 *
 * With no token to spare this is exactly revokeAllSessionsForUser. Passing
 * undefined must not be read as "spare the session whose hash is undefined",
 * which is why the two cases are branches rather than one clever query.
 */
export async function revokeAllSessionsForUserExcept(
	db: D1Database,
	userId: string,
	keepToken: string | undefined,
): Promise<void> {
	if (!keepToken) {
		await revokeAllSessionsForUser(db, userId);
		return;
	}

	await client(db)
		.delete(sessions)
		.where(
			and(
				eq(sessions.user_id, userId),
				ne(sessions.token_hash, await hashToken(keepToken)),
			),
		);
}

/** Which flow a verification token belongs to. */
export type VerificationTokenType = "verify" | "reset";

/**
 * Issue a token for one of the email flows, returning the raw value.
 *
 * The raw token is returned once, here, and never stored - the table keeps only
 * its SHA-256, the same way sessions do. A password-reset token is a bearer
 * credential: whoever holds one can take an account over without knowing the
 * password, so a read of this table must not produce working links.
 *
 * 32 bytes of crypto random, hex encoded. It ends up in a URL, so it has to
 * survive copy-paste out of a mail client, and it has to be unguessable at the
 * rate someone can try links.
 */
export async function createVerificationToken(
	db: D1Database,
	userId: string,
	type: VerificationTokenType,
	expiresAt: Date,
): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

	await client(db)
		.insert(verification_tokens)
		.values({
			id: crypto.randomUUID(),
			user_id: userId,
			token_hash: await hashToken(token),
			type,
			expires_at: expiresAt.toISOString(),
			created_at: new Date().toISOString(),
		});

	return token;
}

/**
 * Spend a token, returning the user it belonged to, or null if it will not do.
 *
 * Null covers every way a token can fail - unknown, wrong flow, expired,
 * already used - deliberately, because the caller has nothing useful to do with
 * the distinction and an error message that explains which one is a hint to
 * whoever is guessing.
 *
 * `type` is checked rather than trusted. Both flows share this table, and a
 * verification link that could be spent as a password reset would be an account
 * takeover: verification links get mailed to addresses that have not yet proven
 * they belong to anyone.
 *
 * Deletion happens whether or not the token was still valid, so a replay of an
 * expired token cannot keep the row alive.
 */
export async function consumeVerificationToken(
	db: D1Database,
	token: string,
	type: VerificationTokenType,
): Promise<string | null> {
	const hash = await hashToken(token);

	const [row] = await client(db)
		.select({
			user_id: verification_tokens.user_id,
			type: verification_tokens.type,
			expires_at: verification_tokens.expires_at,
		})
		.from(verification_tokens)
		.where(eq(verification_tokens.token_hash, hash))
		.limit(1);

	if (!row) return null;

	// A wrong-type presentation is refused WITHOUT spending the token. It says
	// nothing about whether the token is good for its own flow, and the only
	// realistic way to reach it is a bug on our side - endpoints choose the type,
	// users never type it. Burning here would turn one routing mistake of ours
	// into a reset link destroyed under someone who was trying to use it. An
	// attacker gains nothing from the leniency either: holding the token, they
	// could simply present it to the right endpoint.
	if (row.type !== type) return null;

	// Everything past this point spends it, valid or not, so an expired token
	// cannot be replayed to keep its row alive.
	await client(db)
		.delete(verification_tokens)
		.where(eq(verification_tokens.token_hash, hash));

	// Same reasoning as getRefreshToken: expires_at is an ISO string, so a SQL
	// comparison would be lexicographic.
	if (new Date(row.expires_at) < new Date()) return null;

	return row.user_id;
}

/**
 * Drop a user's outstanding tokens for one flow.
 *
 * Called before issuing a replacement, so asking for a second reset link
 * retires the first. Without it every link ever sent stays live until it
 * expires, which turns a mailbox someone else can read into a standing key.
 *
 * Scoped by type: clearing reset links must not un-verify a pending address.
 */
export async function deleteVerificationTokens(
	db: D1Database,
	userId: string,
	type: VerificationTokenType,
): Promise<void> {
	await client(db)
		.delete(verification_tokens)
		.where(
			and(
				eq(verification_tokens.user_id, userId),
				eq(verification_tokens.type, type),
			),
		);
}

/**
 * Who a token belongs to, without spending it.
 *
 * For the check that runs before a reset form is shown. The user has not chosen
 * a new password yet, so consuming here would mean opening the page burned the
 * only link they were sent - and links get opened twice routinely, by mail
 * scanners and by people who clicked before they were ready.
 *
 * Returns the address as well as the id because the page shows whose account is
 * being reset, which is how someone notices a link meant for a different
 * account of theirs.
 */
export async function verificationTokenTarget(
	db: D1Database,
	token: string,
	type: VerificationTokenType,
): Promise<{ userId: string; email: string } | null> {
	const [row] = await client(db)
		.select({
			user_id: verification_tokens.user_id,
			type: verification_tokens.type,
			expires_at: verification_tokens.expires_at,
			email: users.email,
		})
		.from(verification_tokens)
		.innerJoin(users, eq(users.id, verification_tokens.user_id))
		.where(eq(verification_tokens.token_hash, await hashToken(token)))
		.limit(1);

	if (!row) return null;
	if (row.type !== type) return null;
	if (new Date(row.expires_at) < new Date()) return null;

	return { userId: row.user_id, email: row.email };
}
