import {
	type CliLabelInput,
	deleteCliLabels,
	putCliLabels,
} from "../db/project-labels.js";
import { requireMachineToken } from "../middleware/machine-auth.js";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { PROJECT_KEY, validLabel } from "./label-rules";

/**
 * The derivation this server accepts (ONL-197, problem 7). Remote rows are
 * last-writer-wins across machines, which is safe only while every writer
 * derives a label the same way; a CLI that derives differently must be
 * refused, not allowed to alternate a key between two names.
 */
const DERIVATION = 1;

/** A machine has tens of projects; this bounds a body, not a real one. */
const MAX_LABELS = 500;

/**
 * PUT /machine/project-labels
 *
 * Labels a machine derived from its own repositories, sent only after
 * `onlooker project-labels on`. `machine_id` is never read from the body: a
 * remote label has none, and a root label is the token's machine.
 */
export async function handlePutMachineProjectLabels(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId, machineId } = await requireMachineToken(request, env);

	let body: { derivation?: unknown; labels?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw new ApiError(400, "invalid_labels", "Labels must be JSON");
	}
	if (body.derivation !== DERIVATION) {
		throw new ApiError(
			400,
			"unsupported_derivation",
			`This server derives labels with version ${DERIVATION}. Update the CLI.`,
		);
	}
	if (!Array.isArray(body.labels) || body.labels.length > MAX_LABELS) {
		throw new ApiError(
			400,
			"invalid_labels",
			`labels must be an array of at most ${MAX_LABELS}`,
		);
	}

	const labels: CliLabelInput[] = body.labels.map((raw: unknown) => {
		const row = (raw ?? {}) as Record<string, unknown>;
		if (
			typeof row.project_key !== "string" ||
			!PROJECT_KEY.test(row.project_key)
		) {
			throw new ApiError(
				400,
				"invalid_project_key",
				"project_key must be 12 lowercase hex characters",
			);
		}
		if (row.basis !== "remote" && row.basis !== "root") {
			throw new ApiError(400, "invalid_basis", "basis must be remote or root");
		}
		return {
			project_key: row.project_key,
			basis: row.basis,
			label: validLabel(row.label),
		};
	});

	return Response.json(await putCliLabels(env.DB, userId, machineId, labels));
}

/**
 * DELETE /machine/project-labels
 *
 * What `onlooker project-labels off` calls (ONL-197, problem 6). Only rows
 * this machine wrote last: another machine that still consents keeps its
 * own, and re-asserts a shared repo's label on its next sync.
 */
export async function handleDeleteMachineProjectLabels(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const { userId, machineId } = await requireMachineToken(request, env);
	return Response.json({
		deleted: await deleteCliLabels(env.DB, userId, machineId),
	});
}
