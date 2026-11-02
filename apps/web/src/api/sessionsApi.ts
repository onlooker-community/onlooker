import { apiClient } from "./client";

// A person's own read of what POST /machine/sessions has written. Beside
// lessonsApi.ts and machinesApi.ts, deliberately the same shape: transport -
// auth header, retries, refresh-and-replay on 401 - belongs to client.ts and
// is not re-implemented here.
//
// This is NOT the machine-authenticated POST /machine/sessions. That route
// pushes one machine's summaries under requireMachineToken; this reads across
// every machine a user owns, browser-authenticated. Under /api/ for the same
// reason /api/lessons and /api/activity are: this API splits its namespaces
// by who may call them, and a bare /sessions would sit in the machine
// namespace by accident - see the design's Section on the API, and the ruling
// in Task 4's report that corrected an earlier draft's bare path.

export const SESSION_ENDPOINTS = {
	sessions: "/api/sessions",
} as const;

/**
 * One session summary, as the browser reads it. Field names are the API's,
 * not camelCased - matching ActivityEvent and Lesson in lessonsApi.ts.
 *
 * `ended_at` is null while the session is still running - a session with a
 * `session.start` and no `session.end` summarizes as in-progress and updates
 * on a later sync, per the design's Error handling section.
 *
 * `counts_by_prefix` arrives already parsed out of its JSON TEXT column - see
 * SessionSummaryRow in apps/api/src/db/session-summaries.ts - so this type
 * never sees the storage representation either.
 *
 * No contract package backs this shape the way @onlooker-community/lesson-
 * contract backs Lesson: session summaries have no published type, only the
 * shape apps/api/src/db/session-summaries.ts and packages/api-contract agree
 * on, so this is typed locally the same way ActivityEvent is.
 */
export interface SessionSummary {
	session_id: string;
	machine_id: string;
	started_at: string;
	ended_at: string | null;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	/**
	 * Full event type -> count, e.g. `curator.scan.complete` (ONL-128).
	 *
	 * What lets a row say what a plugin did rather than only how much it
	 * fired - see lib/pluginActivity.ts. Empty for a session synced by a CLI
	 * older than 2.12.0, which reported prefixes only. Never absent: the API
	 * defaults the column on read, as it does counts_by_project.
	 */
	counts_by_type: Record<string, number>;
	/**
	 * Project key -> this session's events in that repository (ONL-184).
	 *
	 * The key is an opaque 12-hex hash, never a path or a name, and the web
	 * app has no way to turn it into one yet - so it is shown as-is. Empty for
	 * a session that carried no key: every CLI older than 2.7.0, and any
	 * session run outside a git repository. Never absent: the API defaults the
	 * column on read, see listSessionSummaries in apps/api.
	 */
	counts_by_project: Record<string, ProjectCount>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

/** One repository's share of a session. Mirrors apps/api's ProjectCount. */
export interface ProjectCount {
	/**
	 * `remote` keys come from the origin URL and name the same repository on
	 * every machine. `root` keys hash a local path, so they are only
	 * meaningful on the machine that reported them - see rollupProjects.
	 */
	basis: "remote" | "root";
	event_count: number;
}

/**
 * One page of a user's session history, newest first.
 *
 * Every row here already cleared apps/cli's reporting threshold - a session
 * too small to be worth a line never reaches POST /machine/sessions at all,
 * so this page has no threshold of its own to apply. See DEFAULT_THRESHOLD in
 * apps/cli/src/sessions.ts.
 */
export interface SessionsPage {
	sessions: SessionSummary[];
	cursor: string | null;
	has_more: boolean;
}

export interface ListSessionsOptions {
	cursor?: string | null;
	/**
	 * How many summaries to ask for. The route clamps this at
	 * BROWSE_MAX_LIMIT (200) rather than rejecting an over-large value, so a
	 * caller asking for more simply gets the ceiling.
	 *
	 * SessionsPage asks for 200 so its summary header covers the whole
	 * history in one request. The header stops claiming a total when
	 * `has_more` comes back true - see components/SessionsSummary.tsx.
	 */
	limit?: number;
	/** `<key>` or `<machine_id>:<key>` values; see lib/projectEntries.ts. */
	project?: string[];
}

/**
 * The reader's own session history, newest first.
 *
 * Mirrors listActivity in lessonsApi.ts: the same envelope, the same options
 * shape, the same `if (cursor)` guard treating "" as absent that apps/api
 * matches on its side.
 */
export function listSessions(
	options: ListSessionsOptions = {},
): Promise<SessionsPage> {
	const query = new URLSearchParams();
	if (options.cursor) query.set("cursor", options.cursor);
	if (options.limit) query.set("limit", String(options.limit));
	for (const value of options.project ?? []) query.append("project", value);

	const search = query.toString();
	return apiClient.get<SessionsPage>(
		search
			? `${SESSION_ENDPOINTS.sessions}?${search}`
			: SESSION_ENDPOINTS.sessions,
	);
}
