import { env, exports } from "cloudflare:workers";
import type {
	D1Database,
	D1PreparedStatement,
} from "@cloudflare/workers-types";
import { BASE, TEST_PASSWORD } from "./lessons.js";

/**
 * Shared fixtures for the org suites.
 *
 * `TEST_PASSWORD` is imported, never retyped - the secret-scanning hook blocks
 * any write containing its literal value.
 */

export interface SignedUpUser {
	id: string;
	token: string;
	/**
	 * The refresh token signup handed back.
	 *
	 * Needed by suites that assert what a session survives: the access token
	 * cannot be withdrawn, so the refresh token is the half of the pair that
	 * deletion actually ends.
	 */
	refreshToken: string;
}

/** Create an account through the real signup route; return its id and both tokens. */
export async function signup(
	email: string,
	name = "Ada",
): Promise<SignedUpUser> {
	const response = await exports.default.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
	});

	if (!response.ok) {
		throw new Error(
			`signup(${email}) failed: ${response.status} ${await response.text()}`,
		);
	}

	const body = (await response.json()) as {
		token: string;
		refreshToken: string;
		user: { id: string };
	};
	return {
		id: body.user.id,
		token: body.token,
		refreshToken: body.refreshToken,
	};
}

/**
 * A D1 handle that runs `onWritten` the moment a statement whose SQL matches
 * `write` has executed - alone through `run()`, or as part of a batch.
 *
 * That moment is the earliest a concurrent request could land after a guarded
 * write refused, so any read the code under test makes afterward sees the
 * changed state. A read made inside the same batch as the write does not,
 * which is the property the deletion refusals depend on (ONL-149). It fires
 * after the whole batch rather than mid-batch because D1 runs a batch as one
 * transaction: nothing concurrent can land between its statements.
 *
 * Statements are tagged rather than wrapped in a Proxy, because `batch()`
 * reads the real statement objects it is handed.
 */
export function afterWrite(
	db: D1Database,
	write: RegExp,
	onWritten: () => Promise<unknown>,
): D1Database {
	const tagged = new WeakSet<D1PreparedStatement>();
	const tag = (statement: D1PreparedStatement): D1PreparedStatement => {
		const bind = statement.bind.bind(statement);
		const run = statement.run.bind(statement);
		// bind() returns a new statement, so the tag has to follow it.
		statement.bind = (...values: unknown[]) => tag(bind(...values));
		statement.run = (async () => {
			const result = await run();
			await onWritten();
			return result;
		}) as D1PreparedStatement["run"];
		tagged.add(statement);
		return statement;
	};

	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (query: string) => {
					const statement = target.prepare(query);
					return write.test(query) ? tag(statement) : statement;
				};
			}
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements);
					if (statements.some((statement) => tagged.has(statement))) {
						await onWritten();
					}
					return results;
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A JSON request. Pass null for `token` to call anonymously. */
export function call(
	path: string,
	token: string | null,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	return exports.default.fetch(`${BASE}${path}`, { ...init, headers });
}

/**
 * Clear the org tables and users, in foreign-key order, and the mail counters.
 *
 * Table state persists between tests within a file, so every org suite calls
 * this in beforeEach.
 *
 * Deliberately does NOT touch `lessons` or `lesson_feed`. The source guard in
 * scripts/source-guards.test.sh forbids a query against those tables anywhere
 * under apps/api/src except db/lessons.ts, db/pool.ts, and files ending in
 * `.test.ts` - this file does not, so a DELETE here would be the one query
 * outside an allowed location, caught by the guard's own text match (`DELETE
 * FROM` satisfies its `FROM` pattern). Every sibling suite that seeds a lesson
 * (db/lessons.test.ts, db/pool.test.ts, routes/lessons-browser.test.ts) clears
 * these two tables itself, in its own beforeEach, for the same reason -
 * orgs-lessons.test.ts does the same.
 */
export async function resetOrgTables(): Promise<void> {
	const db = env.DB;
	await db.prepare("DELETE FROM org_invites").run();
	await db.prepare("DELETE FROM org_memberships").run();
	await db.prepare("DELETE FROM orgs").run();
	await db.prepare("DELETE FROM users").run();
	// Not an org table, but every suite that signs up and mails shares the
	// per-address counters otherwise, and the cap would carry from one test
	// into the next (ONL-222).
	await db.prepare("DELETE FROM mail_sends").run();
}
