/**
 * The HTTP contract apps/api serves, asserted against both implementations.
 *
 * This table used to live in apps/web and be checked one way: it pinned the mock
 * to figures captured by hand from a running worker, so the mock could not drift
 * on its own - but nothing re-checked apps/api. If the real API moved, the suite
 * stayed green and the table quietly became fiction. That is the same one-sided
 * guard the table was written to replace, moved up a level.
 *
 * Both sides run this table now. A status code or response shape can only change
 * by changing this file, and changing this file fails whichever implementation
 * has not caught up.
 *
 * Two incidents came out of the gap it closes. /api/dashboard wrapped its payload
 * in { success, data } while the mock returned it bare, so DashboardPage read
 * `.stats` off the envelope, got undefined, and threw mid-render - blanking the
 * page for every logged-in user while the API answered 200 throughout. And the
 * mock's base-URL handling differed from the client's, which made the mock
 * unusable as a substitute for the real thing.
 *
 * Note the first was a SHAPE bug, not a status code: every response involved was
 * a 200 before and after. Status alone would not have caught it, which is why
 * `body` carries as much weight here as `status`.
 */

/** A field that must be present and hold an object. */
export const expectObject = Symbol.for("onlooker.contract.object");
/** A field that must be present and hold an array. */
export const expectArray = Symbol.for("onlooker.contract.array");
/** A field that must be present and hold a non-empty string. */
export const expectString = Symbol.for("onlooker.contract.string");

/**
 * The concrete values a runner supplies, because the two implementations cannot
 * share fixtures.
 *
 * apps/web's mock ships with a seeded account. apps/api starts each run against
 * an empty D1 and has to create one. Expressing cases in terms of roles - "the
 * existing account", "an address nobody has used" - is what lets one table
 * describe both without either side pretending to be the other.
 */
export interface ContractFixture {
	/** An account that already exists when the case runs. */
	existingEmail: string;
	/** The correct password for `existingEmail`. */
	existingPassword: string;
	/** An address no account holds yet. Must differ on every call. */
	freshEmail: () => string;
}

export interface ContractCase {
	/** Reads as "<name> answers <status>" in test output. */
	name: string;
	path: string;
	init: RequestInit;
	status: number;
	/**
	 * Compared as a subset, so adding a field to a response is allowed and
	 * renaming or dropping one is not. Omitted where a case has no body worth
	 * pinning - a 401 carries nothing a client reads beyond the code.
	 */
	body?: Record<string, unknown>;
	/**
	 * Substrings that must not appear anywhere in the serialized body.
	 *
	 * Blunt on purpose. `password_hash` is excluded today only because
	 * getUserById names its columns one by one; a future `.select()` with no
	 * argument would start returning it, every existing assertion would still
	 * pass, and the leak would ship. A substring search over the whole body
	 * catches it wherever it surfaces.
	 */
	forbidden?: string[];
}

function json(payload: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	};
}

const NO_SECRETS = ["password_hash", "passwordHash"];

/**
 * Cases needing no authentication, in the order a new user meets them.
 *
 * Deliberately absent, because the two sides genuinely disagree and pinning
 * either answer would invent a decision that belongs to a human:
 *   - forgot-password: 501 from apps/api, 200 from the mock, which implements
 *     the whole reset flow (onlooker-bde).
 *   - anything after logout: the mock revokes the access token, apps/api leaves
 *     it valid until expiry (onlooker-nmb).
 *   - a second login: the mock rotates, revoking the first session's token;
 *     apps/api leaves it valid, so both sessions live (onlooker-06u). This one
 *     constrains the runners - it is why they take their authenticated token
 *     after these cases have run, since "login, correct credentials" below
 *     would otherwise revoke a token acquired earlier.
 */
export function anonymousCases(fixture: ContractFixture): ContractCase[] {
	return [
		{
			name: "signup, new account",
			path: "/auth/signup",
			init: json({
				email: fixture.freshEmail(),
				password: "correct-horse-battery",
			}),
			status: 201,
			body: { token: expectString, user: expectObject },
			forbidden: NO_SECRETS,
		},
		{
			name: "signup, address already taken",
			path: "/auth/signup",
			init: json({
				email: fixture.existingEmail,
				password: "correct-horse-battery",
			}),
			status: 409,
		},
		{
			name: "login, correct credentials",
			path: "/auth/login",
			init: json({
				email: fixture.existingEmail,
				password: fixture.existingPassword,
			}),
			status: 200,
			body: { token: expectString, user: expectObject },
			forbidden: NO_SECRETS,
		},
		{
			name: "login, wrong password",
			path: "/auth/login",
			init: json({ email: fixture.existingEmail, password: "wrong" }),
			status: 401,
		},
		{
			name: "me, no token",
			path: "/auth/me",
			init: { method: "GET" },
			status: 401,
		},
		{
			name: "dashboard, no token",
			path: "/api/dashboard",
			init: { method: "GET" },
			status: 401,
		},
		{
			name: "users/me, no token",
			path: "/api/users/me",
			init: { method: "GET" },
			status: 401,
		},
	];
}

/**
 * Cases running with a valid access token, which the runner attaches.
 *
 * `body` is the point of this group rather than `status`. All three answered 200
 * before and after the dashboard incident; what broke was the shape underneath.
 *
 * Note that /auth/me and /api/users/me disagree on purpose - the first wraps in
 * `user`, the second returns the profile bare. That is what both implementations
 * do today, and this table records what is, not what would be tidier.
 */
export function authenticatedCases(): ContractCase[] {
	return [
		{
			name: "me, valid token",
			path: "/auth/me",
			init: { method: "GET" },
			status: 200,
			body: { user: expectObject },
			forbidden: NO_SECRETS,
		},
		{
			name: "dashboard, valid token",
			path: "/api/dashboard",
			init: { method: "GET" },
			status: 200,
			// Bare, with no { success, data } wrapper. This is the exact assertion
			// the blanked-dashboard incident needed and did not have.
			body: {
				user: expectObject,
				stats: expectObject,
				recentActivity: expectArray,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "users/me, valid token",
			path: "/api/users/me",
			init: { method: "GET" },
			status: 200,
			body: {
				id: expectString,
				email: expectString,
				createdAt: expectString,
			},
			forbidden: NO_SECRETS,
		},
	];
}

/**
 * Every way `actual` fails to satisfy `expected`, as readable strings. Empty
 * means it matched.
 *
 * Extra keys in `actual` pass: adding a field to a response breaks no client, so
 * the contract should not forbid it. Renaming or dropping one does.
 */
export function shapeFailures(
	actual: unknown,
	expected: Record<string, unknown>,
): string[] {
	if (typeof actual !== "object" || actual === null) {
		return [
			`body is ${actual === null ? "null" : typeof actual}, not an object`,
		];
	}
	const value = actual as Record<string, unknown>;

	return Object.entries(expected).flatMap(([key, want]) => {
		if (!(key in value)) return [`missing "${key}"`];
		const got = value[key];

		if (want === expectObject) {
			return typeof got === "object" && got !== null && !Array.isArray(got)
				? []
				: [`"${key}" should be an object, got ${describe(got)}`];
		}
		if (want === expectArray) {
			return Array.isArray(got)
				? []
				: [`"${key}" should be an array, got ${describe(got)}`];
		}
		if (want === expectString) {
			return typeof got === "string" && got.length > 0
				? []
				: [`"${key}" should be a non-empty string, got ${describe(got)}`];
		}
		return got === want
			? []
			: [`"${key}" should be ${String(want)}, got ${describe(got)}`];
	});
}

/** Forbidden substrings that do appear in the serialized body. */
export function forbiddenPresent(
	body: unknown,
	forbidden: readonly string[],
): string[] {
	const serialized = JSON.stringify(body ?? null);
	return forbidden.filter((needle) => serialized.includes(needle));
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}
