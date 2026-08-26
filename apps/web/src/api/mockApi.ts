import { AuthApiError, decodeJwtPayload } from "@onlooker/auth-react";
import type { User } from "../auth";
import type { DashboardData, UserProfile } from "../types/api";
import {
	AUTH_ENDPOINTS,
	type AuthTokenResponse,
	type RefreshResponse,
} from "./types";

interface MockUser {
	id: string;
	email: string;
	name: string;
	password: string;
}

const MOCK_USERS: Record<string, MockUser> = {
	"test@example.com": {
		id: "user-1",
		email: "test@example.com",
		name: "Test User",
		password: "password123",
	},
};

// email -> every live token for that user, and token -> email (reverse).
//
// Sets rather than single values, because sessions are concurrent. These held
// one token each back when issuing a new pair retired the old one, so "the
// user's token" was unambiguous. It no longer is - a laptop and a phone are
// both live - and anything that has to reach ALL of a user's sessions, like a
// password change, could otherwise only find the most recent one.
const ACCESS_TOKENS = new Map<string, Set<string>>();
const ACCESS_TOKEN_OWNER = new Map<string, string>();
const REFRESH_TOKENS = new Map<string, Set<string>>();
const REFRESH_TOKEN_OWNER = new Map<string, string>();

function trackToken(
	index: Map<string, Set<string>>,
	email: string,
	token: string,
): void {
	const existing = index.get(email);
	if (existing) existing.add(token);
	else index.set(email, new Set([token]));
}
// email -> ISO timestamp of the user's most recent login (WS4 profile/dashboard).
const LAST_LOGIN = new Map<string, string>();
// Tokens explicitly killed (logout / rotation / session invalidation) so a
// still-unexpired JWT can't be replayed after its owner map entry is gone.
const REVOKED_TOKENS = new Set<string>();

// Short-lived access, long-lived refresh. The values are the seam WS3 tunes
// against their proactive-refresh / expiry-warning lead times: the warning must
// lead by less than the access TTL to be visible, and auto-refresh fires just
// before expiry. Shrink ACCESS_TOKEN_TTL_SECONDS for a faster demo loop.
const ACCESS_TOKEN_TTL_SECONDS = 3 * 60; // 3 minutes — short so WS3's 5-min warning fires at login and auto-refresh fires ~60s pre-expiry, both observable in one demo session
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

let tokenCounter = 0;

function base64UrlEncode(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let base64: string;
	if (typeof btoa === "function") {
		let binary = "";
		for (let i = 0; i < bytes.length; i += 1) {
			binary += String.fromCharCode(bytes[i]);
		}
		base64 = btoa(binary);
	} else {
		const nodeBuffer = (globalThis as { Buffer?: typeof globalThis.Buffer })
			.Buffer;
		base64 = nodeBuffer ? nodeBuffer.from(bytes).toString("base64") : "";
	}
	return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mint a real (decodable) JWT with an `exp` claim. The signature segment is a
// fixed placeholder — neither the mock nor the client's `decodeJwtPayload`
// verify it; `exp` is what drives refresh scheduling. NOT for production.
function mintJwt(
	email: string,
	type: "access" | "refresh",
	ttlSeconds: number,
	jti: number,
): string {
	const iat = Math.floor(Date.now() / 1000);
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64UrlEncode(
		JSON.stringify({ sub: email, type, iat, exp: iat + ttlSeconds, jti }),
	);
	return `${header}.${payload}.mock-signature`;
}

// Decode a mock JWT and return its subject email only if it is well-formed, of
// the expected kind, and not expired. Returns undefined otherwise.
function jwtEmailIfValid(
	token: string,
	type: "access" | "refresh",
): string | undefined {
	const payload = decodeJwtPayload(token);
	if (!payload || payload.type !== type) return undefined;
	const exp = typeof payload.exp === "number" ? payload.exp : 0;
	if (Date.now() >= exp * 1000) return undefined;
	return typeof payload.sub === "string" ? payload.sub : undefined;
}

// Resolve the email a bearer access token belongs to. The in-memory owner map
// stays authoritative in-session (so rotation, logout, and email-rename keep
// working); a stateless decode is the fallback when the map is cold — e.g.
// after a page reload — so a valid session survives without server state. Both
// paths honor `exp`, so an aged-out access token 401s and the client refreshes.
function resolveAccessEmail(token: string | undefined): string | undefined {
	if (!token || REVOKED_TOKENS.has(token)) return undefined;
	const decodedEmail = jwtEmailIfValid(token, "access");
	if (!decodedEmail) return undefined; // malformed, wrong kind, or expired
	return ACCESS_TOKEN_OWNER.get(token) ?? decodedEmail;
}

function resolveRefreshEmail(token: string | undefined): string | undefined {
	if (!token || REVOKED_TOKENS.has(token)) return undefined;
	const decodedEmail = jwtEmailIfValid(token, "refresh");
	if (!decodedEmail) return undefined;
	return REFRESH_TOKEN_OWNER.get(token) ?? decodedEmail;
}

function issueTokens(email: string): { token: string; refreshToken: string } {
	tokenCounter += 1;
	const token = mintJwt(
		email,
		"access",
		ACCESS_TOKEN_TTL_SECONDS,
		tokenCounter,
	);
	const refreshToken = mintJwt(
		email,
		"refresh",
		REFRESH_TOKEN_TTL_SECONDS,
		tokenCounter,
	);

	// Issuing a pair no longer retires the user's previous one. It used to, on
	// the reasoning that a superseded token should not be replayable - but
	// apps/api has no such rule, so the effect was that signing in on a second
	// device silently ended the first everywhere except production. Sessions are
	// concurrent (SESSION_LIFECYCLE in @onlooker/api-contract).
	//
	// Refresh still rotates, because there the caller hands over the exact token
	// being replaced; that revocation lives in the /auth/refresh branch, which is
	// the only place that knows which session is being renewed.
	//
	// These two maps still track the most recent pair per user, which is what
	// invalidateSessions() reaches for when a password changes.
	trackToken(ACCESS_TOKENS, email, token);
	ACCESS_TOKEN_OWNER.set(token, email);
	trackToken(REFRESH_TOKENS, email, refreshToken);
	REFRESH_TOKEN_OWNER.set(refreshToken, email);

	return { token, refreshToken };
}

function publicUser(user: MockUser): User {
	return { id: user.id, email: user.email, name: user.name };
}

function readBody<T>(options: RequestInit): T {
	return JSON.parse((options.body as string) ?? "{}") as T;
}

// ---------------------------------------------------------------------------
// WS2 account endpoints (profile, password recovery, email verification,
// account deletion). Purely additive over the WS1 auth mock above — these
// handlers share MOCK_USERS and the token maps so a user created via signup is
// immediately usable here. When WS1 swaps to the real API, this section and its
// matching handlers below can be dropped together.
// ---------------------------------------------------------------------------

interface AccountMeta {
	createdAt: string;
	emailVerified: boolean;
}

const ACCOUNT_META = new Map<string, AccountMeta>();
// reset token -> { email, expiresAt } and verification token -> email.
const RESET_TOKENS = new Map<string, { email: string; expiresAt: number }>();
const VERIFY_TOKENS = new Map<string, string>();
let accountTokenCounter = 0;

const RESET_VERIFY_PREFIX = "/auth/reset-password/verify";

function accountMeta(email: string): AccountMeta {
	let meta = ACCOUNT_META.get(email);
	if (!meta) {
		meta = {
			// The pre-seeded test user reads as an established account; anyone who
			// signs up during the session starts unverified as of now.
			createdAt:
				email === "test@example.com"
					? "2026-01-15T00:00:00.000Z"
					: new Date().toISOString(),
			emailVerified: email === "test@example.com",
		};
		ACCOUNT_META.set(email, meta);
	}
	return meta;
}

function bearerToken(options: RequestInit): string | undefined {
	const header = new Headers(options.headers as HeadersInit | undefined);
	return header.get("Authorization")?.replace("Bearer ", "") || undefined;
}

function emailFromAuthHeader(options: RequestInit): string | undefined {
	return resolveAccessEmail(bearerToken(options));
}

function requireAuth(options: RequestInit): { email: string; user: MockUser } {
	const email = emailFromAuthHeader(options);
	const user = email ? MOCK_USERS[email] : undefined;
	if (!email || !user) {
		throw new AuthApiError(401, "unauthorized", "Invalid token");
	}
	return { email, user };
}

function accountUser(user: MockUser) {
	const meta = accountMeta(user.email);
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		createdAt: meta.createdAt,
		emailVerified: meta.emailVerified,
	};
}

/**
 * End every session this user holds, optionally sparing one refresh token.
 *
 * `spareRefreshToken` is how a password change keeps the session that made it
 * while ending the others - the caller has just proved it knows both passwords,
 * so signing it out is noise. apps/api does the same thing in
 * revokeAllSessionsForUserExcept.
 */
function invalidateSessions(email: string, spareRefreshToken?: string): void {
	for (const token of ACCESS_TOKENS.get(email) ?? []) {
		ACCESS_TOKEN_OWNER.delete(token);
		REVOKED_TOKENS.add(token);
	}
	ACCESS_TOKENS.delete(email);

	const spared = new Set<string>();
	for (const token of REFRESH_TOKENS.get(email) ?? []) {
		if (token === spareRefreshToken) {
			spared.add(token);
			continue;
		}
		REFRESH_TOKEN_OWNER.delete(token);
		REVOKED_TOKENS.add(token);
	}
	if (spared.size > 0) REFRESH_TOKENS.set(email, spared);
	else REFRESH_TOKENS.delete(email);
}

// Move a user (and its live tokens + meta) to a new email key. The existing
// access token stays valid, so the caller's session survives an email change.
function renameUserEmail(oldEmail: string, newEmail: string): void {
	const user = MOCK_USERS[oldEmail];
	if (!user) return;
	user.email = newEmail;
	MOCK_USERS[newEmail] = user;
	delete MOCK_USERS[oldEmail];

	const access = ACCESS_TOKENS.get(oldEmail);
	if (access) {
		ACCESS_TOKENS.set(newEmail, access);
		for (const token of access) ACCESS_TOKEN_OWNER.set(token, newEmail);
		ACCESS_TOKENS.delete(oldEmail);
	}
	const refresh = REFRESH_TOKENS.get(oldEmail);
	if (refresh) {
		REFRESH_TOKENS.set(newEmail, refresh);
		for (const token of refresh) REFRESH_TOKEN_OWNER.set(token, newEmail);
		REFRESH_TOKENS.delete(oldEmail);
	}
	const meta = ACCOUNT_META.get(oldEmail);
	if (meta) {
		ACCOUNT_META.set(newEmail, meta);
		ACCOUNT_META.delete(oldEmail);
	}
}

async function mockAccountApi(
	path: string,
	options: RequestInit,
): Promise<Response | null> {
	// GET /auth/reset-password/verify?token=... — is a reset link still usable?
	if (options.method === "GET" && path.startsWith(RESET_VERIFY_PREFIX)) {
		const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
		const token = new URLSearchParams(query).get("token") ?? "";
		const entry = RESET_TOKENS.get(token);
		const valid = Boolean(entry && entry.expiresAt > Date.now());
		return json({ valid, email: valid ? entry?.email : undefined });
	}

	// POST /auth/forgot-password — issue a reset token; uniform response.
	if (path === "/auth/forgot-password" && options.method === "POST") {
		const { email } = readBody<{ email: string }>(options);
		if (email && MOCK_USERS[email]) {
			accountTokenCounter += 1;
			const token = `mock-reset-${accountTokenCounter}`;
			RESET_TOKENS.set(token, {
				email,
				expiresAt: Date.now() + 60 * 60 * 1000,
			});
			// Dev "mailbox": surface the link so the flow is testable locally.
			console.info(`[mock] password reset link: /reset-password/${token}`);
		}
		// Same response whether or not the address is registered (no enumeration).
		return json({ success: true });
	}

	// POST /auth/reset-password — consume a reset token and set a new password.
	if (path === "/auth/reset-password" && options.method === "POST") {
		const { token, password } = readBody<{ token: string; password: string }>(
			options,
		);
		const entry = token ? RESET_TOKENS.get(token) : undefined;
		if (!entry || entry.expiresAt <= Date.now() || !MOCK_USERS[entry.email]) {
			if (token) RESET_TOKENS.delete(token);
			throw new AuthApiError(
				400,
				"invalid_reset_token",
				"Reset link is invalid or has expired",
			);
		}
		MOCK_USERS[entry.email].password = password;
		RESET_TOKENS.delete(token); // single use
		invalidateSessions(entry.email); // force re-login everywhere
		return json({ success: true });
	}

	// GET /auth/profile — full account profile for the settings page.
	if (path === "/auth/profile" && options.method === "GET") {
		const { user } = requireAuth(options);
		return json({ user: accountUser(user) });
	}

	// PATCH /auth/profile — update name and/or email.
	if (path === "/auth/profile" && options.method === "PATCH") {
		const { email, user } = requireAuth(options);
		const body = readBody<{ name?: string; email?: string }>(options);

		if (typeof body.name === "string" && body.name.trim()) {
			user.name = body.name.trim();
		}

		const nextEmail = typeof body.email === "string" ? body.email.trim() : "";
		if (nextEmail && nextEmail !== email) {
			if (MOCK_USERS[nextEmail]) {
				throw new AuthApiError(
					409,
					"email_taken",
					"That email is already in use",
				);
			}
			renameUserEmail(email, nextEmail);
			accountMeta(nextEmail).emailVerified = false; // re-verify new address
		}

		return json({ user: accountUser(user) });
	}

	// POST /auth/change-password — verify current password, then rotate it.
	if (path === "/auth/change-password" && options.method === "POST") {
		const { email, user } = requireAuth(options);
		const { current_password, new_password, refreshToken } = readBody<{
			current_password: string;
			new_password: string;
			refreshToken?: string;
		}>(options);
		if (user.password !== current_password) {
			throw new AuthApiError(
				401,
				"invalid_password",
				"Current password is incorrect",
			);
		}
		user.password = new_password;

		// Every other session goes. This used to change the password and leave
		// all sessions alone, which was the one place the two implementations
		// disagreed on substance rather than one simply being unbuilt - and the
		// mock disagreed with itself too, since its reset flow already
		// invalidated everything. Someone changing a password is usually acting
		// on the belief the old one is loose.
		invalidateSessions(email, refreshToken);
		return json({ success: true });
	}

	// DELETE /auth/account — remove the user and end all sessions.
	if (path === "/auth/account" && options.method === "DELETE") {
		const { email } = requireAuth(options);
		invalidateSessions(email);
		delete MOCK_USERS[email];
		ACCOUNT_META.delete(email);
		return json({ success: true });
	}

	// POST /auth/resend-verification — issue a fresh verification token.
	if (path === "/auth/resend-verification" && options.method === "POST") {
		const { email } = requireAuth(options);
		accountTokenCounter += 1;
		const token = `mock-verify-${accountTokenCounter}`;
		VERIFY_TOKENS.set(token, email);
		console.info(`[mock] email verification link: /verify-email/${token}`);
		return json({ success: true });
	}

	// POST /auth/verify-email — mark the address verified.
	if (path === "/auth/verify-email" && options.method === "POST") {
		const { token } = readBody<{ token: string }>(options);
		const email = token ? VERIFY_TOKENS.get(token) : undefined;
		if (!email || !MOCK_USERS[email]) {
			throw new AuthApiError(
				400,
				"invalid_verification_token",
				"Verification link is invalid or has expired",
			);
		}
		accountMeta(email).emailVerified = true;
		VERIFY_TOKENS.delete(token);
		return json({ success: true });
	}

	return null; // not an account endpoint — let the auth mock handle it
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

export async function mockAuthApi(
	path: string,
	options: RequestInit,
): Promise<Response> {
	if (path === AUTH_ENDPOINTS.login && options.method === "POST") {
		const { email, password } = readBody<{ email: string; password: string }>(
			options,
		);

		const user = MOCK_USERS[email];
		if (!user || user.password !== password) {
			throw new AuthApiError(
				401,
				"invalid_credentials",
				"Email or password incorrect",
			);
		}

		const { token, refreshToken } = issueTokens(email);
		LAST_LOGIN.set(email, new Date().toISOString());
		const response: AuthTokenResponse = {
			token,
			refreshToken,
			user: publicUser(user),
		};
		return new Response(JSON.stringify(response), { status: 200 });
	}

	if (path === AUTH_ENDPOINTS.signup && options.method === "POST") {
		const { email, password, name } = readBody<{
			email: string;
			password: string;
			name?: string;
		}>(options);

		if (MOCK_USERS[email]) {
			throw new AuthApiError(409, "user_exists", "User already exists");
		}

		const newUser: MockUser = {
			id: `user-${Date.now()}`,
			email,
			name: name || "Anonymous",
			password,
		};
		MOCK_USERS[email] = newUser;

		const { token, refreshToken } = issueTokens(email);
		LAST_LOGIN.set(email, new Date().toISOString());
		const response: AuthTokenResponse = {
			token,
			refreshToken,
			user: publicUser(newUser),
		};
		// 201, matching apps/api. This answered 200 and nothing noticed, because
		// nothing compares the two - see api-contract.test.ts.
		return new Response(JSON.stringify(response), { status: 201 });
	}

	if (path === AUTH_ENDPOINTS.refresh && options.method === "POST") {
		const { refreshToken } = readBody<{ refreshToken?: string }>(options);
		const email = resolveRefreshEmail(refreshToken);

		if (!email || !MOCK_USERS[email]) {
			throw new AuthApiError(
				401,
				"invalid_refresh_token",
				"Refresh token is invalid or expired",
			);
		}

		// Rotation, and the only place it belongs: the caller has named the exact
		// token it is replacing, so retiring that one ends no other session.
		// apps/api does the same - handleRefresh revokes the presented refresh
		// token before storing its replacement.
		if (refreshToken) {
			REVOKED_TOKENS.add(refreshToken);
			REFRESH_TOKEN_OWNER.delete(refreshToken);
		}

		const rotated = issueTokens(email);
		const response: RefreshResponse = {
			token: rotated.token,
			refreshToken: rotated.refreshToken,
		};
		return new Response(JSON.stringify(response), { status: 200 });
	}

	if (path === AUTH_ENDPOINTS.me && options.method === "GET") {
		const email = resolveAccessEmail(bearerToken(options));

		if (!email || !MOCK_USERS[email]) {
			throw new AuthApiError(401, "unauthorized", "Invalid token");
		}

		return new Response(
			JSON.stringify({ user: publicUser(MOCK_USERS[email]) }),
			{
				status: 200,
			},
		);
	}

	if (path === AUTH_ENDPOINTS.logout && options.method === "POST") {
		// Revokes the refresh token in the body and nothing else, matching
		// apps/api. See SESSION_LIFECYCLE in @onlooker/api-contract for why the
		// access token is left alone: it is a stateless JWT there, so no amount of
		// bookkeeping on this side could withdraw one, and a mock that pretends
		// otherwise teaches the app a guarantee production does not offer.
		//
		// This used to revoke the presented access token and call
		// invalidateSessions(), which ended every session that user had. Both were
		// fictions - one about a token the real server cannot reach, the other
		// about devices it was never told to sign out.
		const { refreshToken } = readBody<{ refreshToken?: string }>(options);
		if (refreshToken) {
			REVOKED_TOKENS.add(refreshToken);
			REFRESH_TOKEN_OWNER.delete(refreshToken);
		}
		return new Response(JSON.stringify({ success: true }), { status: 200 });
	}

	const accountResponse = await mockAccountApi(path, options);
	if (accountResponse) return accountResponse;

	throw new AuthApiError(404, "not_found", `Mock endpoint not found: ${path}`);
}

/**
 * A machine as the mock holds it. Mirrors MachineTokenSummary in
 * apps/api/src/db/machine-tokens.ts field for field - everything the browser
 * is allowed to see, which is everything except anything that authenticates.
 */
interface MockMachine {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

/**
 * Per-account machines, keyed by email like the rest of the mock's state.
 *
 * The lesson pool above is permanently empty because only a machine-
 * authenticated push can fill it and a browser cannot make one. Machines are
 * the opposite: a browser is the only thing that can mint one, so the mock can
 * model the whole lifecycle - and has to, because the reveal, the "never used"
 * treatment and revoke are otherwise unreachable in development.
 */
const MACHINES = new Map<string, MockMachine[]>();

function machinesOf(email: string): MockMachine[] {
	const existing = MACHINES.get(email);
	if (existing) return existing;
	const fresh: MockMachine[] = [];
	MACHINES.set(email, fresh);
	return fresh;
}

let mockMachineCounter = 0;

/**
 * `onlk_` plus 64 hex characters, the shape createMachineToken mints.
 *
 * Deterministic rather than random on purpose: the mock is not a security
 * boundary, and a predictable value is assertable. The shape still matters -
 * the contract's forbidden list greps for the prefix, so a mock minting a
 * different one would let a leaked token through on the side the gate cannot
 * see. The raw value is returned and then dropped; nothing here retains it.
 */
function mintMockMachineToken(): string {
	mockMachineCounter += 1;
	return `onlk_${mockMachineCounter.toString(16).padStart(64, "0")}`;
}

// ---------------------------------------------------------------------------
// WS4 protected data endpoints backing the authenticated Profile and Dashboard
// pages. Additive over the auth + account mocks above and sharing their user +
// token state. When WS1 swaps to the real API, `/api/users/me` and
// `/api/dashboard` move server-side.
// ---------------------------------------------------------------------------

export async function mockDataApi(
	path: string,
	options: RequestInit,
): Promise<Response> {
	if (path === "/api/users/me" && (options.method ?? "GET") === "GET") {
		const { email, user } = requireAuth(options);
		const profile: UserProfile = {
			id: user.id,
			email: user.email,
			name: user.name,
			createdAt: accountMeta(email).createdAt,
			lastLoginAt: LAST_LOGIN.get(email) ?? accountMeta(email).createdAt,
		};
		return json(profile);
	}

	if (path === "/api/dashboard" && (options.method ?? "GET") === "GET") {
		const { email, user } = requireAuth(options);
		const createdAt = accountMeta(email).createdAt;
		const lastLoginAt = LAST_LOGIN.get(email) ?? createdAt;
		const data: DashboardData = {
			user: { id: user.id, email: user.email, name: user.name },
			stats: {
				totalSessions: 42,
				activeProjects: 3,
				unreadNotifications: 5,
			},
			recentActivity: [
				{
					id: "act-1",
					type: "login",
					description: "Signed in to the web app",
					timestamp: lastLoginAt,
				},
				{
					id: "act-2",
					type: "account",
					description: "Account created",
					timestamp: createdAt,
				},
			],
		};
		return json(data);
	}

	// The hosted pool, mocked. The mock has no lessons and no way to acquire
	// any - lessons arrive by machine-authenticated push, which a browser
	// cannot make - so this is permanently the empty-pool case. That is enough
	// for the contract, which pins the envelope shape rather than contents.
	//
	// Matched on the pathname alone. `path` here still carries the search
	// string - toHandlerPath returns `pathname + search`, because the
	// reset-link handler reads its token straight out of it - so an equality
	// check against "/api/lessons" would stop matching the moment the app
	// asked for ?limit= or ?status=, which is every real call it makes.
	const poolPath = path.split("?")[0];

	if (poolPath === "/api/lessons" && (options.method ?? "GET") === "GET") {
		requireAuth(options);

		// Mirrors handleBrowseLessons in apps/api. The mock accepting a query
		// the API rejects is the same class of divergence as the error envelope:
		// it makes a broken request look fine in development.
		const query = new URLSearchParams(path.split("?")[1] ?? "");

		for (const status of query.getAll("status")) {
			if (!["active", "refuted", "superseded", "retracted"].includes(status)) {
				throw new AuthApiError(
					400,
					"invalid_status",
					"status must be one of active, refuted, superseded, retracted",
				);
			}
		}

		// The real cursor is base64 of `<promoted_at>\n<id>`; anything else was
		// not minted here. The mock's pool is always empty, so a well-formed
		// cursor still yields nothing - only the rejection needs to match.
		const cursor = query.get("cursor");
		// `if (cursor)` and not `!== null`: URLSearchParams returns "" for a
		// bare `?cursor=`, and apps/api guards with `if (opts.cursor)`, which
		// treats "" as absent. Rejecting it here would 400 a request production
		// answers 200 - the same divergence this task exists to close, inverted.
		if (cursor) {
			let decoded: string | null = null;
			try {
				decoded = atob(cursor);
			} catch {
				decoded = null;
			}
			// decodeCursor requires BOTH parts non-empty, not merely two of them:
			// `!promotedAt || !id` in apps/api/src/db/lessons.ts. Counting parts
			// alone accepts "\nabc" and "abc\n", which the API rejects - the same
			// under-rejection this task exists to close, pointed at the mock.
			const parts = decoded === null ? [] : decoded.split("\n");
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				throw new AuthApiError(
					400,
					"invalid_cursor",
					"That cursor was not issued by this server; start from the first page",
				);
			}
		}

		return json({ lessons: [], cursor: null, has_more: false });
	}

	if (
		poolPath.startsWith("/api/lessons/") &&
		poolPath.endsWith("/status") &&
		options.method === "PATCH"
	) {
		requireAuth(options);
		const { status } = JSON.parse(String(options.body ?? "{}")) as {
			status?: unknown;
		};
		if (status !== "active" && status !== "retracted") {
			throw new AuthApiError(
				400,
				"status_not_allowed",
				"A lesson may be retracted or made active again from here.",
			);
		}
		// The pool is always empty here, so any id is one nobody holds.
		throw new AuthApiError(404, "not_found", "No such lesson");
	}

	if (
		poolPath.startsWith("/api/lessons/") &&
		(options.method ?? "GET") === "GET"
	) {
		requireAuth(options);
		throw new AuthApiError(404, "not_found", "No such lesson");
	}

	if (poolPath === "/api/machines" && (options.method ?? "GET") === "GET") {
		const { email } = requireAuth(options);
		return json({ machines: machinesOf(email) });
	}

	if (poolPath === "/api/machines" && options.method === "POST") {
		const { email } = requireAuth(options);
		const body = readBody<{ name?: unknown }>(options);
		// Trimmed before the emptiness check, matching handleCreateMachine.
		// A mock that accepted "   " would let a machine named nothing into
		// the list in development and 400 in production.
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			throw new AuthApiError(400, "invalid_name", "A machine needs a name");
		}

		mockMachineCounter += 1;
		const id = `mock-machine-${mockMachineCounter}`;
		machinesOf(email).push({
			id,
			name,
			created_at: new Date().toISOString(),
			last_used_at: null,
			revoked_at: null,
		});

		// The raw token appears here and nowhere else, ever - the same promise
		// handleCreateMachine makes. Nothing above stored it.
		return json({ id, name, token: mintMockMachineToken() }, 201);
	}

	if (poolPath.startsWith("/api/machines/") && options.method === "DELETE") {
		const { email } = requireAuth(options);
		const id = poolPath.slice("/api/machines/".length);
		const machine = machinesOf(email).find(
			(candidate) => candidate.id === id && !candidate.revoked_at,
		);
		// 404 and not 403, matching handleRevokeMachine. A 403 would confirm
		// the id exists, which is an existence oracle over other users' rows -
		// and because the lookup is scoped to this account, "someone else's"
		// and "never existed" are already indistinguishable here.
		if (!machine) {
			throw new AuthApiError(404, "not_found", "No such machine");
		}
		machine.revoked_at = new Date().toISOString();
		return json({ success: true });
	}

	throw new AuthApiError(404, "not_found", `Mock endpoint not found: ${path}`);
}

function errorResponse(error: unknown): Response {
	if (error instanceof AuthApiError) {
		// Byte-identical to apps/api's errorHandler, including the header. A
		// mock that answers in a different shape than the thing it stands in
		// for is worse than no mock: it makes development pass and production
		// fail. The Content-Type was missing here too.
		return new Response(
			JSON.stringify({
				success: false,
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			}),
			{
				status: error.status,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	throw new Error(message);
}

/**
 * Reduce whatever the client built to the path the handlers match on.
 *
 * Every handler compares bare paths - `path === "/auth/signup"` - but the URL
 * arriving here is absolute whenever VITE_API_BASE_URL is set. Without this the
 * mock silently worked only with an empty base, which happened to be the
 * default, so the failure surfaced as "Mock endpoint not found" naming a URL
 * rather than anything about the base.
 *
 * The search string is kept because handlers read it: the reset-link check
 * pulls its token straight out of this string.
 */
function toHandlerPath(url: string): string {
	try {
		// The base only matters for relative inputs; absolute URLs ignore it.
		const parsed = new URL(url, "http://mock.invalid");
		return parsed.pathname + parsed.search;
	} catch {
		return url;
	}
}

export function createMockFetch() {
	return async (url: string, options: RequestInit = {}) => {
		const path = toHandlerPath(url);

		if (path.startsWith("/auth/")) {
			try {
				return await mockAuthApi(path, options);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (path.startsWith("/api/")) {
			try {
				return await mockDataApi(path, options);
			} catch (error) {
				return errorResponse(error);
			}
		}

		// Anything the mock does not own goes to the network as it was given,
		// not as the normalized path.
		return fetch(url, options);
	};
}
