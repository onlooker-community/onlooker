import type { Principal } from "../db/pool.js";
import {
	clearProjectLabel,
	labelFor,
	listProjectLabels,
	ownsMachine,
	setProjectLabel,
} from "../db/project-labels.js";
import type { RouteParams, WorkerEnv } from "../types";
import { ApiError } from "../types";
import { PROJECT_KEY, validLabel } from "./label-rules";

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
 * A clear answers with the label the list now shows, which is the CLI's when
 * one exists.
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
			label: await labelFor(env.DB, userId, projectKey, machineId),
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
