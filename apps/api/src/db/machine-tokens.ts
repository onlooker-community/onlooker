import type { D1Database } from "@cloudflare/workers-types";
import { machine_tokens } from "@onlooker/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { hashToken } from "../utils/crypto.js";
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

/**
 * Every machine this user has, revoked ones included, oldest first.
 *
 * Without an explicit order this relied on incidental SQLite behavior, while
 * the mock returns machines in insertion order and mockMachines.test.ts pins
 * that order (`["work laptop", "desktop"]`) - so a real backend that answered
 * in a different order would contradict the mock without either suite
 * catching it.
 */
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
		.where(eq(machine_tokens.user_id, userId))
		.orderBy(asc(machine_tokens.created_at));
}
