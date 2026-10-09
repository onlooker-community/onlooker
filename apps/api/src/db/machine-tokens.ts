import type { D1Database } from "@cloudflare/workers-types";
import { machine_tokens } from "@onlooker/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { hashToken } from "../utils/crypto.js";
import { client } from "./client.js";
import { pluginCount } from "./machine-inventory.js";

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
	/** When this machine last reported an inventory. Null means never. */
	inventory_at: string | null;
	/**
	 * How many plugins the reported inventory names, never the inventory
	 * itself - a list of machines must not carry every machine's document.
	 *
	 * Null rather than zero when nothing was reported: zero is a claim about
	 * the machine, null is a claim about what we know.
	 */
	plugin_count: number | null;
	/**
	 * The org this token pushes to, or null for a private-only token.
	 *
	 * An id rather than a name: the only page that renders this already lists
	 * the caller's orgs to offer the picker, so it can resolve the name
	 * itself, and a join here would put a second query in front of a list that
	 * does not need one.
	 */
	org_id: string | null;
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
	orgId: string | null = null,
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
			org_id: orgId,
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
): Promise<{ userId: string; machineId: string; orgId: string | null } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;

	const rows = await client(db)
		.select({
			id: machine_tokens.id,
			user_id: machine_tokens.user_id,
			org_id: machine_tokens.org_id,
		})
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

	// The machine id travels with the owner because the lookup already has it.
	// Without it a caller knows whose token this is but not which machine is
	// speaking, and a machine describing itself has to land on its own row.
	//
	// The org travels with the credential because that is where push reads it
	// from: the server stamps the lesson's org from the token rather than from
	// the request, so a client cannot name an org its holder does not belong
	// to. Null means a private-only token.
	return { userId: row.user_id, machineId: row.id, orgId: row.org_id };
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
	const rows = await client(db)
		.select({
			id: machine_tokens.id,
			name: machine_tokens.name,
			created_at: machine_tokens.created_at,
			last_used_at: machine_tokens.last_used_at,
			revoked_at: machine_tokens.revoked_at,
			inventory: machine_tokens.inventory,
			inventory_at: machine_tokens.inventory_at,
			org_id: machine_tokens.org_id,
		})
		.from(machine_tokens)
		.where(eq(machine_tokens.user_id, userId))
		.orderBy(asc(machine_tokens.created_at));

	// The document is read here and deliberately not returned. Selecting it
	// only to count it keeps the response small while letting the summary be
	// derived rather than stored - a stored count could disagree with the
	// document it describes.
	return rows.map(({ inventory, ...row }) => ({
		...row,
		plugin_count: pluginCount(inventory),
	}));
}
