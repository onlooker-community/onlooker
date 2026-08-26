import { SELF } from "cloudflare:test";

export const BASE = "https://api.onlooker.dev";
const PASSWORD = "correct-horse-battery";

let counter = 0;

/** Reset between suites so ids are stable within a run. */
export function resetLessonCounter(): void {
	counter = 0;
}

/** A lesson that violates nothing, so a caller can break exactly one thing. */
export function lesson(overrides: Record<string, unknown> = {}) {
	counter += 1;
	return {
		id: `01KZ45MKAM734ZS7JK24D2DK${counter.toString().padStart(2, "0")}`,
		schema_version: 2,
		claim: "Pin rollup when vite is below 6",
		rationale: "The bundled rollup version drifts",
		evidence: {
			artifact_ids: ["01KZ45MKAM734ZS7JK24D2DK0R"],
			session_ids: ["session-01"],
			project_key: "0123456789ab",
			observed_at: "2026-08-22T00:00:00.000Z",
			resolution: "pinned rollup",
		},
		applies_to: {
			stack: ["vite"],
			scope: { kind: "versioned", versions: { vite: "<6" } },
			file_patterns: [],
			task_kinds: [],
		},
		visibility: "private",
		consensus: { judges: 3, agreed: 2, decided_at: "2026-08-22T00:00:00.000Z" },
		status: "active",
		superseded_by: null,
		source: "local",
		author_key: "a".repeat(32),
		promoted_at: "2026-08-22T00:00:00.000Z",
		...overrides,
	};
}

/** Everything a test needs to use, and then revoke, one machine. */
export interface MintedMachine {
	/** The machine row's id, for DELETE /api/machines/:id. */
	id: string;
	/** The machine credential, for the sync routes. */
	token: string;
	/** The browser session, which is what may revoke the machine. */
	accessToken: string;
}

/**
 * Sign up, then mint a machine token for that account.
 *
 * Note the destructure-rename. BOTH responses have a field called `token` and
 * they are different credentials: /auth/signup returns the browser access token
 * as `token` (not `accessToken` - check contract.test.ts, which reads
 * `body.token`), and /machines returns the machine token, also as `token`.
 * Reading the wrong one sends `Bearer undefined` and every authenticated case
 * 401s. Both are named here so a caller cannot pick up the wrong one silently.
 */
export async function mintMachine(email: string): Promise<MintedMachine> {
	const signup = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	const { token: accessToken } = (await signup.json()) as { token: string };

	const machine = await SELF.fetch(`${BASE}/api/machines`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ name: "test machine" }),
	});
	const { id, token } = (await machine.json()) as { id: string; token: string };
	return { id, token, accessToken };
}

/** {@link mintMachine} for the callers that only ever want the credential. */
export async function mintMachineToken(email: string): Promise<string> {
	return (await mintMachine(email)).token;
}

export function push(token: string, lessons: unknown[]) {
	return SELF.fetch(`${BASE}/lessons`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ lessons }),
	});
}
