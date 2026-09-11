import {
	getMachineInventory,
	putMachineInventory,
} from "../db/machine-inventory.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/**
 * Generous against the ~22 KB a 28-plugin machine produces, bounded so a
 * machine credential cannot write an unbounded blob into D1.
 */
const MAX_INVENTORY_BYTES = 256 * 1024;

/** The only document shape this server knows how to store. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * A machine may describe itself.
 *
 * `machines.ts` states deliberately that machine management is browser-
 * authenticated and never machine-authenticated, because a credential that
 * could mint successors would make revocation meaningless. That rule governs
 * minting and enumerating, and this route does neither: the credential names
 * exactly one machine, the write targets only that machine's own row, and
 * nothing here can read or name another.
 */
export async function handlePutInventory(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { machineId } = await requireMachineToken(request, env);

	const raw = await request.text();
	// Measured in bytes, not characters: a document of multi-byte names is
	// larger than its length suggests, and the cap exists to bound storage.
	if (new TextEncoder().encode(raw).length > MAX_INVENTORY_BYTES) {
		throw new ApiError(
			413,
			"inventory_too_large",
			"Inventory document is too large",
		);
	}

	let body: { schema_version?: unknown; plugins?: unknown };
	try {
		body = JSON.parse(raw) as { schema_version?: unknown; plugins?: unknown };
	} catch {
		throw new ApiError(400, "invalid_inventory", "Inventory must be JSON");
	}

	if (body.schema_version !== SUPPORTED_SCHEMA_VERSION) {
		throw new ApiError(
			400,
			"unsupported_schema_version",
			`Inventory schema_version must be ${SUPPORTED_SCHEMA_VERSION}`,
		);
	}
	if (!Array.isArray(body.plugins)) {
		throw new ApiError(
			400,
			"invalid_inventory",
			"Inventory needs a plugins array",
		);
	}

	// Stored verbatim. The server never reads inside the document, so
	// re-serializing it would only introduce a way for what is stored to
	// differ from what the machine actually reported.
	await putMachineInventory(env.DB, machineId, raw, new Date().toISOString());

	return Response.json({ ok: true });
}

/**
 * One machine's inventory, for the person who owns it.
 *
 * Browser-authenticated and separate from `GET /api/machines` on purpose: the
 * list carries a count, this carries the document. Folding the document into
 * the list would send every machine's whole inventory to render a page that
 * shows one.
 */
export async function handleGetInventory(
	request: Request,
	env: WorkerEnv,
	params: RouteParams,
): Promise<Response> {
	const { userId } = await requireAuth(request, env);

	const found = await getMachineInventory(env.DB, userId, params.id);
	// 404 covers never-reported and not-yours alike. The second is deliberate:
	// distinguishing them would confirm which ids exist.
	if (!found) {
		throw new ApiError(
			404,
			"not_found",
			"This machine has not reported an inventory",
		);
	}

	// Parsed rather than passed through as a string, so the client receives an
	// object like every other route's body and does not parse twice.
	return Response.json({
		inventory: JSON.parse(found.inventory) as unknown,
		inventory_at: found.inventory_at,
	});
}
