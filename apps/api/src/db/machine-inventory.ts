import type { D1Database } from "@cloudflare/workers-types";
import { machine_tokens } from "@onlooker/db";
import { and, eq, isNull } from "drizzle-orm";
import { client } from "./client.js";

/**
 * Replace one machine's reported inventory.
 *
 * Replacement rather than accumulation, so re-running `onlooker sync` is free.
 * The document is stored exactly as the machine sent it - the server never
 * reads inside it, and re-serializing would only create a way for what is
 * stored to differ from what was reported.
 */
export async function putMachineInventory(
	db: D1Database,
	machineId: string,
	document: string,
	at: string,
): Promise<void> {
	await client(db)
		.update(machine_tokens)
		.set({ inventory: document, inventory_at: at })
		.where(eq(machine_tokens.id, machineId));
}

/**
 * One machine's inventory, or null when it has never reported one.
 *
 * Scoped by `userId` as well as id, so another account's machine reads as
 * absent rather than forbidden. A 403 here would confirm the id exists, which
 * is the existence oracle `revokeMachineToken` already refuses to be.
 */
export async function getMachineInventory(
	db: D1Database,
	userId: string,
	machineId: string,
): Promise<{ inventory: string; inventory_at: string } | null> {
	const rows = await client(db)
		.select({
			inventory: machine_tokens.inventory,
			inventory_at: machine_tokens.inventory_at,
		})
		.from(machine_tokens)
		.where(
			and(
				eq(machine_tokens.id, machineId),
				eq(machine_tokens.user_id, userId),
				isNull(machine_tokens.revoked_at),
			),
		)
		.limit(1);

	const row = rows[0];
	if (!row?.inventory || !row.inventory_at) return null;
	return { inventory: row.inventory, inventory_at: row.inventory_at };
}

/**
 * How many plugins a stored document names, or null when there is nothing to
 * count.
 *
 * Null for unreported and for unreadable alike, because the machines list has
 * no way to act on the difference and zero would be a lie in both cases. A
 * document that cannot be parsed is still a report; it is just not one this
 * summary can describe.
 */
export function pluginCount(document: string | null): number | null {
	if (!document) return null;
	try {
		const parsed = JSON.parse(document) as { plugins?: unknown };
		return Array.isArray(parsed.plugins) ? parsed.plugins.length : null;
	} catch {
		return null;
	}
}
