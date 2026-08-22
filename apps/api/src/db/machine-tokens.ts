import type { D1Database } from "@cloudflare/workers-types";
import { machine_tokens } from "@onlooker/db";
import { and, eq, isNull } from "drizzle-orm";
import { client } from "./client.js";

/**
 * A machine token as the web app is allowed to see it: everything except
 * anything that could be used to authenticate.
 */
export interface MachineTokenSummary {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

/**
 * The prefix is not decoration. It makes the value recognizable in a paste and
 * greppable by secret scanners, which is what gets a leaked credential noticed.
 */
const TOKEN_PREFIX = "onlk_";

/**
 * SHA-256 of the raw token. Machine tokens store only this, the same way
 * sessions and verification_tokens do.
 *
 * Not bcrypt, deliberately. The token is 256 bits of crypto random, not a
 * password - there is no dictionary to slow an attacker down, so a work factor
 * buys nothing, and it would be paid on every sync request.
 */
async function hashToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Issue a machine token, returning the raw value exactly once.
 *
 * 32 bytes from crypto.getRandomValues, matching createVerificationToken.
 * Math.random() is not a CSPRNG and must not be used here - see onlooker-axo,
 * which tracks the existing misuse in generateRefreshToken.
 */
export async function createMachineToken(
	db: D1Database,
	userId: string,
	name: string,
): Promise<{ id: string; token: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token =
		TOKEN_PREFIX +
		[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	const id = crypto.randomUUID();

	await client(db)
		.insert(machine_tokens)
		.values({
			id,
			user_id: userId,
			name,
			token_hash: await hashToken(token),
			created_at: new Date().toISOString(),
		});

	return { id, token };
}

/**
 * Resolve a presented token to the user it belongs to, or null.
 *
 * A revoked token resolves to null rather than throwing, so callers cannot
 * accidentally distinguish "revoked" from "never existed" and turn this into an
 * oracle for which tokens once existed.
 */
export async function verifyMachineToken(
	db: D1Database,
	token: string,
): Promise<string | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;

	const rows = await client(db)
		.select({ id: machine_tokens.id, user_id: machine_tokens.user_id })
		.from(machine_tokens)
		.where(
			and(
				eq(machine_tokens.token_hash, await hashToken(token)),
				isNull(machine_tokens.revoked_at),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row) return null;

	await client(db)
		.update(machine_tokens)
		.set({ last_used_at: new Date().toISOString() })
		.where(eq(machine_tokens.id, row.id));

	return row.user_id;
}

/**
 * Revoke one machine. Returns false when the token does not exist or belongs to
 * someone else - the caller cannot tell those apart, which is deliberate.
 */
export async function revokeMachineToken(
	db: D1Database,
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await client(db)
		.update(machine_tokens)
		.set({ revoked_at: new Date().toISOString() })
		.where(
			and(
				eq(machine_tokens.id, id),
				eq(machine_tokens.user_id, userId),
				isNull(machine_tokens.revoked_at),
			),
		)
		.returning({ id: machine_tokens.id });

	return result.length > 0;
}

/** Every machine this user has, revoked ones included. */
export async function listMachineTokens(
	db: D1Database,
	userId: string,
): Promise<MachineTokenSummary[]> {
	return client(db)
		.select({
			id: machine_tokens.id,
			name: machine_tokens.name,
			created_at: machine_tokens.created_at,
			last_used_at: machine_tokens.last_used_at,
			revoked_at: machine_tokens.revoked_at,
		})
		.from(machine_tokens)
		.where(eq(machine_tokens.user_id, userId));
}
