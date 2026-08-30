export { redactSecrets } from "./redact";

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
 *
 * /api/dashboard itself was deleted in onlooker-yfw - it served three numbers
 * invented for a scaffold. The incident that named it is why this table exists,
 * so the account above is kept rather than edited out with the route.
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
 * Nothing is excluded any more. This list once carried three entries where the
 * two sides disagreed and pinning either answer would have invented a decision:
 * session lifecycle, second logins, and forgot-password. The first two became
 * SESSION_LIFECYCLE; the last became real when the API grew a reset flow.
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
			name: "users/me, no token",
			path: "/api/users/me",
			init: { method: "GET" },
			status: 401,
		},
	];
}

/**
 * What a session survives, and what ends it.
 *
 * This is a decision, recorded, not a description of an accident. The two
 * implementations disagreed three ways and the disagreement traced to one
 * question: can an access token be withdrawn before it expires? A stateless JWT
 * cannot be - verification is a signature check with no lookup - so any answer
 * that claims otherwise is either a lie or a per-request database read.
 *
 * The answer taken:
 *
 *   Logout revokes the refresh token for the session that asked, and nothing
 *   else. The access token stays valid for the rest of its short life. Before
 *   this, apps/api revoked NOTHING on logout - measured, not assumed - so a
 *   logged-out session could refresh itself forever, each refresh minting a new
 *   30-day window. That was the actual exposure, and it was unbounded.
 *
 *   Sessions are concurrent and independently terminable. A second login does
 *   not disturb the first, and logging out one device does not sign out the
 *   others. The mock used to rotate on every issue, ending the prior session;
 *   that made a laptop and a phone mutually exclusive in development and not in
 *   production.
 *
 *   The residual window is the access-token lifetime, deliberately. An access
 *   token denylist would close it completely at the cost of a KV read on every
 *   authenticated request, forever; shortening the lifetime buys nearly the same
 *   protection for nothing. TOKEN_REVOCATION in WorkerEnv is where a denylist
 *   would go if that trade ever changes.
 *
 * Both runners drive these as an ordered flow rather than single requests, since
 * each step depends on the last. The numbers live here so the decision has one
 * home; the mechanics differ per side because the mock and SELF are reached
 * differently.
 */
export const SESSION_LIFECYCLE = {
	/** The access token still works right after logout - it cannot be withdrawn. */
	accessTokenAfterLogout: 200,
	/** The refresh token is gone, so the session cannot renew itself. */
	refreshAfterLogout: 401,
	/** Logging in again leaves the earlier session untouched. */
	firstSessionAfterSecondLogin: 200,
	/** And the earlier session can still be ended on its own. */
	refreshAfterLoggingOutTheFirstSession: 401,
} as const;

/**
 * Minting, listing and revoking a machine credential.
 *
 * Driven as a flow rather than as cases, because every step needs the id or
 * the token the one before it returned, and a static `path` cannot say "revoke
 * the one you just made."
 *
 * This surface had no contract of any kind until 2026-08-25. It was registered
 * outside `/api/`, so no case could reach it through the mock, which made the
 * one place in the product that mints a credential the only one outside the
 * gate this package exists to be.
 */
export const MACHINE_LIFECYCLE = {
	/** Minting answers 201 and hands back the raw token. */
	create: 201,
	/**
	 * The prefix the raw token carries. Not decoration: it makes the value
	 * recognizable in a paste and greppable by secret scanners, which is what
	 * gets a leaked credential noticed.
	 */
	tokenPrefix: "onlk_",
	/** A name that is blank or only whitespace mints nothing. */
	blankName: 400,
	/**
	 * The raw token is in the create response and nowhere else, ever. The list
	 * is where a second copy would surface if one existed, so the list is where
	 * this is asserted.
	 */
	tokenInList: false,
	/** Revoking one you own succeeds. */
	revokeOwn: 200,
	/**
	 * And revoking it again answers 404, not 200. The row is already out of the
	 * caller's reach; reporting success twice would tell a user that a second
	 * revoke did something.
	 */
	revokeTwice: 404,
	/**
	 * Another user's machine answers 404, not 403. A 403 confirms the id
	 * exists, which is an existence oracle over other users' rows.
	 */
	revokeSomeoneElses: 404,
	/**
	 * The exact fields a listed machine carries - nothing more asserted here,
	 * because extra fields are allowed and these five are the ones the page
	 * reads by name (`id`, `created_at` and `last_used_at` render the row;
	 * `name` labels it; `revoked_at` decides whether it gets a Revoke button).
	 *
	 * Nothing else in this package pins them: the static case below asserts
	 * only `body: { machines: expectArray }`, and apps/api's own
	 * machine-tokens.test.ts reads `revoked_at`/`last_used_at` as raw DB
	 * columns via `db().prepare()`, never as JSON keys a client would see. A
	 * select alias renamed in `listMachineTokens` could ship - every suite and
	 * `tsc` green - while the page silently rendered "Never used" for every
	 * machine and "Invalid Date" under Created. This is the one place that
	 * rename fails.
	 */
	listFields: ["id", "name", "created_at", "last_used_at", "revoked_at"],
	/**
	 * The exact fields the create response carries. `name` is rendered by
	 * `TokenReveal` ("the token for <name>") and was asserted nowhere before
	 * this - a rename here would blank that sentence with every other check
	 * still passing.
	 */
	createFields: ["id", "name", "token"],
} as const;

/**
 * The account-management surface: reading a profile, editing it, changing a
 * password, deleting an account.
 *
 * These were 501 stubs in apps/api while apps/web's mock implemented all of
 * them, so the settings page worked in development and did not exist in
 * production. The mock therefore set the contract by default, and this records
 * what it had already decided rather than inventing anything.
 *
 * Driven as flows, because each step depends on the last and two of them are
 * destructive.
 */
export const ACCOUNT_CONTRACT = {
	/** Editing to an address another account holds. */
	emailTaken: 409,
	/**
	 * Changing an address clears its verified mark. The new address has proven
	 * nothing, and carrying the old proof across would make the flag a lie.
	 */
	emailChangeClearsVerification: false,
	/** Changing a password without the current one right. */
	wrongCurrentPassword: 401,
	/** The old password stops working immediately. */
	loginWithOldPasswordAfterChange: 401,
	/** And the new one starts. */
	loginWithNewPasswordAfterChange: 200,
	/**
	 * A password change ends every other session.
	 *
	 * This is the one place the two implementations genuinely disagreed rather
	 * than one being unimplemented: the mock changed the password and left every
	 * session alone. That is the wrong answer. Someone changing a password is
	 * usually acting on the belief that the old one is compromised, and leaving
	 * the attacker's session live defeats the act. apps/web's own reset flow
	 * already invalidated sessions, so the mock was inconsistent with itself.
	 *
	 * The session that made the change keeps working - being asked to sign in
	 * again immediately after proving you know both passwords is noise.
	 */
	otherSessionsAfterPasswordChange: 401,
	/** Deleting an account takes its sessions with it. */
	refreshAfterAccountDeleted: 401,
	/** And the account is really gone, not just flagged. */
	loginAfterAccountDeleted: 401,
} as const;

/**
 * Email verification and password reset.
 *
 * The uniform forgot-password response is the load-bearing part. Anything that
 * varies with whether an address is registered - status, body, or noticeably,
 * timing - turns this endpoint into a way to ask who has an account here, which
 * is exactly what someone assembling a credential-stuffing list wants to know.
 *
 * Both implementations answer 200 with the same body either way.
 */
export const EMAIL_FLOW_CONTRACT = {
	/** Asking to reset a registered address. */
	forgotPasswordKnownAddress: 200,
	/** And an unregistered one. Identical, deliberately. */
	forgotPasswordUnknownAddress: 200,
	/** Checking a live reset link is a read, so the link still works afterward. */
	verifyResetTokenStillSpendable: true,
	/** Checking any link answers 200 - "not valid" is an answer, not an error. */
	verifyResetTokenStatus: 200,
	/** A reset link works exactly once. */
	resetPasswordReplayed: 400,
	/** A reset ends every session, since the old credentials are suspect. */
	sessionsAfterReset: 401,
	/** A verification link cannot be spent as a password reset. */
	crossFlowTokenUse: 400,
	/** An unknown or expired verification token. */
	verifyEmailInvalidToken: 400,
} as const;

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
			name: "profile, valid token",
			path: "/auth/profile",
			init: { method: "GET" },
			status: 200,
			// The settings page reads createdAt and emailVerified off this and
			// nothing else provides them - /auth/me returns the slimmer user.
			body: { user: expectObject },
			forbidden: NO_SECRETS,
		},
		{
			name: "me, valid token",
			path: "/auth/me",
			init: { method: "GET" },
			status: 200,
			body: { user: expectObject },
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
		{
			name: "lesson pool, empty",
			path: "/api/lessons",
			init: { method: "GET" },
			status: 200,
			// Bare, and `lessons` is an array even when there is nothing in it.
			// An empty pool is not a 404 and not a null - the two-pane UI
			// renders an empty state from this, and a missing key throws.
			// `cursor` is pinned too - it is the field the pagination loop
			// reads, and its absence produces an infinite loop, not a visible
			// error.
			body: {
				lessons: expectArray,
				cursor: null,
				has_more: false,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "lesson pool, filtered and limited",
			path: "/api/lessons?status=active&limit=10",
			init: { method: "GET" },
			status: 200,
			// The query string is the point of this case, not the filter. The
			// mock matches on a path that still carries `?...`, so an equality
			// check there passes the case above and fails every real call the
			// app makes. One case with parameters is what keeps the two
			// implementations honest about parsing them at all.
			body: {
				lessons: expectArray,
				cursor: null,
				has_more: false,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "machines list, valid token",
			path: "/api/machines",
			init: { method: "GET" },
			status: 200,
			// `machines` is an array even when the account has none. The page
			// renders its empty state from this, and a missing key throws.
			body: { machines: expectArray },
			// Not the bare word "token": a machine someone names "work token
			// laptop" would trip a substring search and fail a green suite for
			// no reason. `onlk_` is the prefix every minted token carries and
			// nothing else does, which makes it the exact tripwire for the one
			// thing that must never appear in a list response.
			forbidden: [...NO_SECRETS, "token_hash", "onlk_"],
		},
		{
			name: "machine with a blank name",
			path: "/api/machines",
			init: json({ name: "   " }),
			status: 400,
		},
		{
			name: "an unknown lesson status is rejected",
			path: "/api/lessons?status=banana",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
		{
			name: "an empty cursor is treated as no cursor",
			path: "/api/lessons?cursor=",
			init: { method: "GET" },
			status: 200,
			body: {
				lessons: expectArray,
				cursor: null,
				has_more: false,
			},
			forbidden: NO_SECRETS,
		},
		{
			name: "a cursor this server did not mint is rejected",
			path: "/api/lessons?cursor=not-a-real-cursor",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
		{
			// CmFiYw== is base64 of "\nabc" - well-formed base64, two parts, but
			// the first is empty. decodeCursor requires BOTH parts non-empty, not
			// merely two of them, so this must be rejected the same as garbage.
			name: "a cursor missing half its key is rejected",
			path: "/api/lessons?cursor=CmFiYw%3D%3D",
			init: { method: "GET" },
			status: 400,
			forbidden: NO_SECRETS,
		},
		{
			name: "lesson that nobody holds",
			path: "/api/lessons/01NOPE00000000000000000000",
			init: { method: "GET" },
			status: 404,
			forbidden: NO_SECRETS,
		},
		{
			name: "transition to a status the browser may not assert",
			path: "/api/lessons/01NOPE00000000000000000000/status",
			init: {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "refuted" }),
			},
			// 400 and not 404: the status is rejected before the lesson is
			// looked up, so this holds without either side seeding a lesson.
			status: 400,
			forbidden: NO_SECRETS,
		},
		{
			name: "an error carries the shared envelope",
			path: "/api/lessons/01NOPE00000000000000000000",
			init: { method: "GET" },
			status: 404,
			// The one case that pins an ERROR body rather than just its status.
			// Every other error case here asserts status alone, which is how the
			// mock and apps/api managed to disagree about this shape for months:
			// the suite built to catch drift could not see it. `error` must be an
			// object, not a bare code string - that difference put an object in
			// AuthApiError.code and made `err.code === "..."` false in production.
			body: {
				success: false,
				error: expectObject,
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
	/**
	 * Key prefix for failure messages, so a nested failure reads `error.code`
	 * rather than `code`. Internal - callers pass nothing.
	 */
	path = "",
): string[] {
	if (typeof actual !== "object" || actual === null) {
		return [
			`${path || "body"} is ${actual === null ? "null" : typeof actual}, not an object`,
		];
	}
	const value = actual as Record<string, unknown>;

	return Object.entries(expected).flatMap(([key, want]) => {
		const here = path ? `${path}.${key}` : key;
		if (!(key in value)) return [`missing "${here}"`];
		const got = value[key];

		if (want === expectObject) {
			return typeof got === "object" && got !== null && !Array.isArray(got)
				? []
				: [`"${here}" should be an object, got ${describe(got)}`];
		}
		if (want === expectArray) {
			return Array.isArray(got)
				? []
				: [`"${here}" should be an array, got ${describe(got)}`];
		}
		if (want === expectString) {
			return typeof got === "string" && got.length > 0
				? []
				: [`"${here}" should be a non-empty string, got ${describe(got)}`];
		}

		// A plain object expectation describes a nested shape, and is compared as
		// a subset just like the top level. Before this branch existed the value
		// fell through to `got === want` below - a reference comparison against a
		// fresh object literal, which failed unconditionally. So nobody could
		// write a nested expectation, everyone reached for `expectObject`, and
		// that says nothing about the contents. A renamed `code` passed the suite.
		//
		// Placement relative to the symbol checks above is not load-bearing: the
		// three expectations are `Symbol.for(...)` values, and `typeof aSymbol` is
		// "symbol", so this guard cannot catch them wherever it sits.
		if (typeof want === "object" && want !== null && !Array.isArray(want)) {
			return shapeFailures(got, want as Record<string, unknown>, here);
		}

		return got === want
			? []
			: [`"${here}" should be ${String(want)}, got ${describe(got)}`];
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
