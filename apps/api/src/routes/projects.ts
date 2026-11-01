import type { Principal } from "../db/pool.js";
import { listProjects } from "../db/projects.js";
import type { RouteParams, WorkerEnv } from "../types";

/**
 * GET /api/projects
 *
 * The viewer's own projects (ONL-209). Declared `auth: "session"`, like
 * GET /api/project-labels.
 */
export async function handleGetProjects(
	_request: Request,
	env: WorkerEnv,
	_params: RouteParams,
	principal: Principal | null,
): Promise<Response> {
	// The router resolved this from the route's `auth: "session"`, which throws
	// rather than returning null, so it cannot be null here.
	const { userId } = principal as Principal;
	return Response.json({ projects: await listProjects(env.DB, userId) });
}
