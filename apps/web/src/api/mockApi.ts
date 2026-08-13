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

// email -> currently valid access token, and access token -> email (reverse).
const ACCESS_TOKENS = new Map<string, string>();
const ACCESS_TOKEN_OWNER = new Map<string, string>();
// email -> currently valid refresh token, and refresh token -> email (reverse).
const REFRESH_TOKENS = new Map<string, string>();
const REFRESH_TOKEN_OWNER = new Map<string, string>();
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

	// Rotation: retire and revoke any tokens previously issued for this user so a
	// superseded (but still unexpired) token can't be replayed.
	const priorAccess = ACCESS_TOKENS.get(email);
	if (priorAccess) {
		ACCESS_TOKEN_OWNER.delete(priorAccess);
		REVOKED_TOKENS.add(priorAccess);
	}
	const priorRefresh = REFRESH_TOKENS.get(email);
	if (priorRefresh) {
		REFRESH_TOKEN_OWNER.delete(priorRefresh);
		REVOKED_TOKENS.add(priorRefresh);
	}

	ACCESS_TOKENS.set(email, token);
	ACCESS_TOKEN_OWNER.set(token, email);
	REFRESH_TOKENS.set(email, refreshToken);
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

function invalidateSessions(email: string): void {
	const access = ACCESS_TOKENS.get(email);
	if (access) {
		ACCESS_TOKEN_OWNER.delete(access);
		REVOKED_TOKENS.add(access);
	}
	const refresh = REFRESH_TOKENS.get(email);
	if (refresh) {
		REFRESH_TOKEN_OWNER.delete(refresh);
		REVOKED_TOKENS.add(refresh);
	}
	ACCESS_TOKENS.delete(email);
	REFRESH_TOKENS.delete(email);
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
		ACCESS_TOKEN_OWNER.set(access, newEmail);
		ACCESS_TOKENS.delete(oldEmail);
	}
	const refresh = REFRESH_TOKENS.get(oldEmail);
	if (refresh) {
		REFRESH_TOKENS.set(newEmail, refresh);
		REFRESH_TOKEN_OWNER.set(refresh, newEmail);
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
		const { user } = requireAuth(options);
		const { current_password, new_password } = readBody<{
			current_password: string;
			new_password: string;
		}>(options);
		if (user.password !== current_password) {
			throw new AuthApiError(
				401,
				"invalid_password",
				"Current password is incorrect",
			);
		}
		user.password = new_password;
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
		return new Response(JSON.stringify(response), { status: 200 });
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
		const token = bearerToken(options);
		// Resolve the owner even if the token has aged out, so logging out an
		// expired session still tears it down. Then revoke the presented token.
		const email =
			(token ? ACCESS_TOKEN_OWNER.get(token) : undefined) ??
			(token
				? (decodeJwtPayload(token)?.sub as string | undefined)
				: undefined);
		if (token) REVOKED_TOKENS.add(token);
		if (email) invalidateSessions(email);
		return new Response(JSON.stringify({ success: true }), { status: 200 });
	}

	const accountResponse = await mockAccountApi(path, options);
	if (accountResponse) return accountResponse;

	throw new AuthApiError(404, "not_found", `Mock endpoint not found: ${path}`);
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

	throw new AuthApiError(404, "not_found", `Mock endpoint not found: ${path}`);
}

function errorResponse(error: unknown): Response {
	if (error instanceof AuthApiError) {
		const apiError = error as AuthApiError;
		return new Response(
			JSON.stringify({
				error: apiError.code,
				message: apiError.message,
				details: apiError.details,
			}),
			{ status: apiError.status },
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
