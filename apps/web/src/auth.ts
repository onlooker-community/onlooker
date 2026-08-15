import type { AuthResponse, AuthSession } from "@onlooker/auth-react";
import { createReactAuth } from "@onlooker/auth-react";
import {
	activeApiConfig,
	apiClient,
	refreshTokens,
	setUnauthorizedHandler,
	tokenStore,
} from "./api/client";
import {
	AUTH_ENDPOINTS,
	type AuthTokenResponse,
	type MeResponse,
} from "./api/types";

export interface User {
	id: string;
	email: string;
	name?: string;
}

// Empty extra session state. `Record<never, never>` (not `Record<string, never>`)
// avoids an index signature that would clash with the `user` field in AuthSession.
export type AppAuthState = Record<never, never>;

// Coordination seam: the real API client lives in `./api/client`. Re-exported
// here so existing consumers importing from `../auth` keep working while
// workstreams migrate to importing `../api/client` directly.
export {
	apiClient,
	authenticatedFetch,
	refreshTokens,
	tokenStore,
} from "./api/client";

/** How long before expiry the client silently renews the access token. */
export const AUTO_REFRESH_LEAD_MS = 3 * 60_000;
/**
 * How long before expiry the user is warned — deliberately shorter than
 * AUTO_REFRESH_LEAD_MS, so the warning means the silent renewal did not work.
 */
export const EXPIRY_WARNING_LEAD_MS = 2 * 60_000;

export const auth = createReactAuth<User, AppAuthState>({
	tokenStorage: tokenStore,
	initialState: {},
	// Set explicitly, and in this order - refresh lead ABOVE warning lead - so
	// the app tries to fix the problem before mentioning it. SessionExpiryBanner
	// is a role="alert" plate with a countdown, and it should mean "something
	// went wrong", not "time is passing".
	//
	// The defaults are the other way round (refresh at 1 min, warn at 5), which
	// made the banner appear on every single token and then vanish when the
	// automatic refresh silently succeeded. At the old 180-minute lifetime that
	// was four minutes of banner every three hours and nobody noticed. At 15
	// minutes it would be four minutes out of every fifteen - over a quarter of
	// the session, forever, re-announced to screen readers each time.
	//
	// Both are fractions of TOKEN_EXPIRY_MINUTES in apps/api/wrangler.toml, and
	// session-leads.test.ts fails if that value moves without these.
	autoRefreshLeadMs: AUTO_REFRESH_LEAD_MS,
	expiryWarningLeadMs: EXPIRY_WARNING_LEAD_MS,
	loadSession: async (): Promise<AuthSession<User, AppAuthState>> => {
		// Throws on failure (e.g. unrecoverable 401); createReactAuth resets state.
		const response = await apiClient.get<MeResponse>(AUTH_ENDPOINTS.me);
		return { user: response.user };
	},
	login: async (
		email: string,
		password: string,
	): Promise<AuthResponse<User>> => {
		const response = await apiClient.post<AuthTokenResponse>(
			AUTH_ENDPOINTS.login,
			{ email, password },
		);
		tokenStore.setRefreshToken(response.refreshToken);
		return { token: response.token, user: response.user };
	},
	signup: async (
		email: string,
		password: string,
		name?: string,
	): Promise<AuthResponse<User>> => {
		const response = await apiClient.post<AuthTokenResponse>(
			AUTH_ENDPOINTS.signup,
			{ email, password, name },
		);
		tokenStore.setRefreshToken(response.refreshToken);
		return { token: response.token, user: response.user };
	},
	logout: async () => {
		try {
			// The refresh token is the whole payload of a logout. It names the
			// session being ended, and it is the only half of the pair the server
			// can revoke - the access token is a stateless JWT it holds no record
			// of. Sending an empty body, which is what this did, told the server
			// who was leaving but not which session to close, so it closed none:
			// a logged-out session could refresh itself indefinitely.
			//
			// Read before the request, because the `finally` below clears it.
			await apiClient.post(AUTH_ENDPOINTS.logout, {
				refreshToken: tokenStore.getRefreshToken() ?? undefined,
			});
		} finally {
			// Always clear local tokens even if the server call fails.
			tokenStore.clear();
		}
	},
	// WS3: proactive, scheduled refresh (fires ~1 min before token expiry),
	// layered on top of the reactive on-401 refresh in ./api/client. Both reuse
	// the same single-flight refreshTokens(), so proactive and reactive refresh
	// can never race. Throwing forces the factory to re-login.
	refreshSession: async (): Promise<AuthSession<User, AppAuthState>> => {
		const refreshed = await refreshTokens();
		if (!refreshed) {
			throw new Error("Session refresh failed");
		}
		const response = await apiClient.get<MeResponse>(AUTH_ENDPOINTS.me);
		return { user: response.user };
	},
	// WS3: extra cleanup for reactive logout paths (failed refresh, cross-tab
	// logout) where the API logout call is skipped — clears the refresh token
	// too, which the factory's access-token storage doesn't own.
	onLogoutCleanup: () => {
		tokenStore.clear();
	},
	// WS3: cross-tab sync watches this localStorage key for login/logout in
	// other tabs. Kept in lock-step with the client's configured access key.
	tokenStorageKey: activeApiConfig.tokenStorageKey,
});

// WS3: route the API client's terminal-401 signal (a mid-session request whose
// token refresh failed) to a local-only session reset, so RequireAuth redirects
// to /login. Local-only (never POSTs /auth/logout) so it can't re-enter the
// client's 401 path and loop.
setUnauthorizedHandler(() => {
	auth.expireSession();
});
