import { env, SELF } from "cloudflare:test";
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
}

/** Create an account through the real signup route; return its id and access token. */
export async function signup(
	email: string,
	name = "Ada",
): Promise<SignedUpUser> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
	});
	const body = (await response.json()) as {
		token: string;
		user: { id: string };
	};
	return { id: body.user.id, token: body.token };
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
	return SELF.fetch(`${BASE}${path}`, { ...init, headers });
}

/**
 * Clear the org tables and users, in foreign-key order.
 *
 * Table state persists between tests within a file, so every org suite calls
 * this in beforeEach.
 */
export async function resetOrgTables(): Promise<void> {
	const db = env.DB;
	await db.prepare("DELETE FROM org_invites").run();
	await db.prepare("DELETE FROM org_memberships").run();
	await db.prepare("DELETE FROM orgs").run();
	await db.prepare("DELETE FROM users").run();
}
