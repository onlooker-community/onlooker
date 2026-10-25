import type { Principal } from "../db/pool.js";
import {
	clearProjectLabel,
	listProjectLabels,
	ownsMachine,
	setProjectLabel,
} from "../db/project-labels.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";

/** A project key as the CLI derives it: the first 12 hex of a SHA-256. */
const PROJECT_KEY = /^[0-9a-f]{12}$/;

/**
 * Bounded in bytes, because the cap exists to bound storage, and a name of
 * multi-byte characters is larger than its length suggests.
 */
const MAX_LABEL_BYTES = 200;

/**
 * Characters a name has no use for and a display can be fooled by.
 *
 * Cc is the control characters, newlines included. Cf is the invisible
 * formatting ones - zero-width spaces and joiners, the byte-order mark, and
 * the bidi overrides that reorder whatever follows them. Zl and Zp are the
 * line and paragraph separators. Cs, under the `u` flag, is a lone surrogate
 * that JSON can carry and nothing can render.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * GET /api/project-labels
 *
 * The browser's names for its project keys (ONL-189). Declared
 * `auth: "session"`, like GET /api/sessions: a machine token fails in
 * `resolvePrincipal` before this body runs.
 */
export async function handleGetProjectLabels(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	return Response.json({ labels: await listProjectLabels(env.DB, userId) });
}

/**
 * PUT /api/project-labels
 *
 * Name one key, or clear its name with `label: null`. `machine_id` is null
 * for a remote key and the reporting machine for a root one, the scoping
 * rollupProjects gives the key on the web side.
 *
 * Only the user writes here. A label the CLI derives (ONL-197) is a separate,
 * machine-authenticated route, writing `source = 'cli'` beside these rows.
 */
export async function handlePutProjectLabel(
	request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	const { userId } = principal as Principal;

	let body: { project_key?: unknown; machine_id?: unknown; label?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw new ApiError(400, "invalid_label", "Label must be JSON");
	}

	const projectKey = body.project_key;
	if (typeof projectKey !== "string" || !PROJECT_KEY.test(projectKey)) {
		throw new ApiError(
			400,
			"invalid_project_key",
			"project_key must be 12 lowercase hex characters",
		);
	}

	const machineId = body.machine_id;
	if (machineId !== null && typeof machineId !== "string") {
		throw new ApiError(
			400,
			"invalid_machine_id",
			"machine_id must be a machine's id, or null for a remote key",
		);
	}
	// 404 rather than 403, as for any other resource that is not the caller's:
	// whether someone else's machine id exists is not this user's to learn.
	if (machineId !== null && !(await ownsMachine(env.DB, userId, machineId))) {
		throw new ApiError(404, "not_found", "No such machine");
	}

	if (body.label === null) {
		await clearProjectLabel(env.DB, userId, projectKey, machineId);
		return Response.json({
			project_key: projectKey,
			machine_id: machineId,
			label: null,
		});
	}

	const label = validLabel(body.label);
	await setProjectLabel(env.DB, userId, {
		project_key: projectKey,
		machine_id: machineId,
		label,
	});
	return Response.json({
		project_key: projectKey,
		machine_id: machineId,
		label,
	});
}

/** The label to store, trimmed, or a 400 saying what is wrong with it. */
function validLabel(raw: unknown): string {
	if (typeof raw !== "string") {
		throw new ApiError(
			400,
			"invalid_label",
			"label must be a string, or null to clear it",
		);
	}
	// Checked before trimming, so a trailing newline is refused rather than
	// quietly removed - it is never part of a name someone meant to type.
	if (FORBIDDEN.test(raw)) {
		throw new ApiError(
			400,
			"invalid_label",
			"label must not contain control or invisible formatting characters",
		);
	}
	const label = raw.trim();
	if (label === "") {
		throw new ApiError(400, "invalid_label", "label must not be empty");
	}
	if (new TextEncoder().encode(label).length > MAX_LABEL_BYTES) {
		throw new ApiError(
			400,
			"invalid_label",
			`label must be at most ${MAX_LABEL_BYTES} bytes`,
		);
	}
	return label;
}
