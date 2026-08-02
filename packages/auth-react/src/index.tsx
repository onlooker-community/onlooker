import {
	AuthApiError,
	type AuthResponse,
	type AuthSession,
} from "@onlooker/auth-core";
import { createContext, useContext } from "react";
import { getTokenExpiration as defaultGetTokenExpiration } from "./jwt";
import { computeExpirySchedule } from "./schedule";

// ============================================================================
// Token Storage
// ============================================================================

export interface AuthTokenStorage {
	getToken(): string | null;
	setToken(token: string): void;
	clearToken(): void;
}

export function createLocalStorageTokenStorage(
	key: string = "auth_token",
	storage: Storage = typeof window !== "undefined"
		? window.localStorage
		: (undefined as any),
): AuthTokenStorage {
	return {
		getToken: () => {
			if (!storage) return null;
			try {
				return storage.getItem(key);
			} catch {
				return null;
			}
		},
		setToken: (token: string) => {
			if (!storage) return;
			try {
				storage.setItem(key, token);
			} catch {
				// Silently fail if storage is full or unavailable
			}
		},
		clearToken: () => {
			if (!storage) return;
			try {
				storage.removeItem(key);
			} catch {
				// Silently fail
			}
		},
	};
}

// ============================================================================
// API Client
// ============================================================================

export interface AuthApiClientOptions {
	baseUrl?: string;
	tokenStorage: AuthTokenStorage;
	onUnauthorized?: () => void;
	fetchImpl?: typeof fetch;
}

export function createAuthApiClient(options: AuthApiClientOptions) {
	const fetchImpl =
		options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
	const baseUrl = options.baseUrl ?? "";

	if (!fetchImpl) {
		throw new Error("fetch is not available—provide fetchImpl in options");
	}

	async function request<T>(
		method: string,
		path: string,
		body?: unknown,
		init: RequestInit = {},
	): Promise<T> {
		const token = options.tokenStorage.getToken();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(init.headers as Record<string, string> | undefined),
		};

		const response = await (fetchImpl as typeof fetch)(`${baseUrl}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			...init,
		});

		const data = await response.json().catch(() => ({}));

		if (response.status === 401) {
			options.tokenStorage.clearToken();
			options.onUnauthorized?.();
			throw new AuthApiError(401, "unauthorized", "Session expired");
		}

		if (!response.ok) {
			throw new AuthApiError(
				response.status,
				(data as any).error ?? "unknown_error",
				(data as any).message ??
					`Request failed with status ${response.status}`,
				(data as any).details,
			);
		}

		return data as T;
	}

	return {
		request,
		get<T>(path: string, init?: RequestInit) {
			return request<T>("GET", path, undefined, init);
		},
		post<T>(path: string, body?: unknown, init?: RequestInit) {
			return request<T>("POST", path, body, init);
		},
		patch<T>(path: string, body?: unknown, init?: RequestInit) {
			return request<T>("PATCH", path, body, init);
		},
		delete<T>(path: string, init?: RequestInit) {
			return request<T>("DELETE", path, undefined, init);
		},
	};
}

// ============================================================================
// React Auth Factory
// ============================================================================

import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { Navigate, useLocation } from "react-router-dom";

/**
 * A subset of the `window` interface sufficient for cross-tab `storage` events.
 * Injectable so multi-tab sync can be unit-tested without a DOM.
 */
export interface StorageEventTarget {
	addEventListener(
		type: "storage",
		listener: (event: StorageEvent) => void,
	): void;
	removeEventListener(
		type: "storage",
		listener: (event: StorageEvent) => void,
	): void;
}

export interface CreateReactAuthOptions<TUser, TExtra extends object> {
	tokenStorage: AuthTokenStorage;
	initialState: TExtra;
	loadSession: () => Promise<AuthSession<TUser, TExtra>>;
	login: (email: string, password: string) => Promise<AuthResponse<TUser>>;
	signup: (
		email: string,
		password: string,
		name?: string,
	) => Promise<AuthResponse<TUser>>;
	hydrateAfterLogin?: (
		response: AuthResponse<TUser>,
	) => Promise<AuthSession<TUser, TExtra>>;
	hydrateAfterSignup?: (
		response: AuthResponse<TUser>,
	) => Promise<AuthSession<TUser, TExtra>>;
	refreshSession?: () => Promise<AuthSession<TUser, TExtra>>;
	logout?: () => Promise<void> | void;

	// --- Session lifecycle (WS3) ---------------------------------------------

	/**
	 * Extract token expiration (ms epoch) from the stored token. Defaults to
	 * reading the JWT `exp` claim; returns null for opaque tokens.
	 */
	getTokenExpiration?: (token: string) => number | null;
	/**
	 * Refresh this many ms before expiry. Default 60_000 (1 minute).
	 */
	autoRefreshLeadMs?: number;
	/**
	 * Flag `sessionExpiringSoon` and fire `onSessionExpiringSoon` this many ms
	 * before expiry. Default 300_000 (5 minutes).
	 */
	expiryWarningLeadMs?: number;
	/**
	 * localStorage key that holds the access token, watched for cross-tab
	 * `storage` events. Default "auth_token".
	 */
	tokenStorageKey?: string;
	/**
	 * Event target for multi-tab sync. Defaults to `window` when available;
	 * pass `null` to disable multi-tab sync entirely.
	 */
	storageEventTarget?: StorageEventTarget | null;
	/**
	 * Called when the session enters the expiry-warning window.
	 */
	onSessionExpiringSoon?: (expiresAt: number) => void;
	/**
	 * Extra cleanup on logout (local or cross-tab): clear refresh tokens, abort
	 * in-flight requests, etc. Runs after the token is cleared.
	 */
	onLogoutCleanup?: () => void;
}

export type ReactAuthState<TUser, TExtra extends object> = {
	user: TUser | null;
	loading: boolean;
	error: string | null;
	/** ms epoch when the current access token expires, or null if unknown. */
	sessionExpiresAt: number | null;
	/** True within the expiry-warning window before `sessionExpiresAt`. */
	sessionExpiringSoon: boolean;
} & TExtra & {
		login: (email: string, password: string) => Promise<void>;
		signup: (email: string, password: string, name?: string) => Promise<void>;
		logout: () => Promise<void>;
		refresh: () => Promise<void>;
	};

export function createReactAuth<TUser, TExtra extends object>(
	options: CreateReactAuthOptions<TUser, TExtra>,
) {
	type AuthState = ReactAuthState<TUser, TExtra>;

	const AuthContext = createContext<AuthState | null>(null);

	const getExpiration = options.getTokenExpiration ?? defaultGetTokenExpiration;
	const autoRefreshLeadMs = options.autoRefreshLeadMs ?? 60_000;
	const expiryWarningLeadMs = options.expiryWarningLeadMs ?? 5 * 60_000;
	const tokenStorageKey = options.tokenStorageKey ?? "auth_token";

	/** Expiry (ms epoch) of whatever token is currently in storage. */
	function currentTokenExpiry(): number | null {
		const token = options.tokenStorage.getToken();
		return token ? getExpiration(token) : null;
	}

	function resolveStorageTarget(): StorageEventTarget | null {
		if (options.storageEventTarget !== undefined) {
			return options.storageEventTarget;
		}
		return typeof window !== "undefined" ? window : null;
	}

	// Bridges the app's transport layer to the live provider's local logout.
	// The mounted provider populates this; `expireSession` (on the returned
	// object) calls through it so app code outside React — e.g. an API client's
	// terminal-401 handler — can trigger a session reset without a hook.
	let requestLocalLogout: (() => void) | null = null;
	function expireSession(): void {
		requestLocalLogout?.();
	}

	function useAuth(): AuthState {
		const context = useContext(AuthContext);
		if (!context) {
			throw new Error("useAuth must be used within AuthProvider");
		}
		return context;
	}

	function useAuthState(): AuthState {
		const initialExtraState = useMemo(() => options.initialState, []);
		const [state, setState] = useState<any>(() => {
			const hasToken = Boolean(options.tokenStorage.getToken());
			return {
				user: null,
				loading: hasToken,
				error: null,
				sessionExpiresAt: hasToken ? currentTokenExpiry() : null,
				sessionExpiringSoon: false,
				...initialExtraState,
			};
		});

		const setPartialState = useCallback((partial: Record<string, any>) => {
			setState((current: any) => ({ ...current, ...partial }));
		}, []);

		const applySession = useCallback((session: AuthSession<TUser, TExtra>) => {
			const { user, ...extra } = session;
			setState((current: any) => ({
				...current,
				...extra,
				user,
				loading: false,
				error: null,
				sessionExpiresAt: currentTokenExpiry(),
				sessionExpiringSoon: false,
			}));
		}, []);

		const resetState = useCallback(() => {
			setState({
				...initialExtraState,
				user: null,
				loading: false,
				error: null,
				sessionExpiresAt: null,
				sessionExpiringSoon: false,
			});
		}, [initialExtraState]);

		// --- Task 3.3: logout with API-first cleanup ---------------------------
		// Call the logout endpoint while the token is still present so the server
		// can invalidate the session, THEN clear local storage and run extra
		// cleanup (refresh token, in-flight request abort). `callApi: false` is
		// used for reactive logouts (failed refresh, cross-tab) where hitting the
		// endpoint again would be redundant or loop.
		const performLogout = useCallback(
			async ({ callApi }: { callApi: boolean }) => {
				if (callApi) {
					try {
						await options.logout?.();
					} catch {
						// Best-effort: never block local cleanup on a failed API call.
					}
				}
				options.tokenStorage.clearToken();
				options.onLogoutCleanup?.();
				resetState();
			},
			[resetState],
		);

		const logout = useCallback(
			() => performLogout({ callApi: true }),
			[performLogout],
		);

		const refresh = useCallback(async () => {
			try {
				const session = options.refreshSession
					? await options.refreshSession()
					: await options.loadSession();
				applySession(session);
			} catch {
				// Task 3.2: force re-login when refresh fails. Local-only cleanup —
				// the refresh already proved the session is gone server-side.
				await performLogout({ callApi: false });
			}
		}, [applySession, performLogout]);

		// --- Task 3.1: session hydration on app load ---------------------------
		useEffect(() => {
			const token = options.tokenStorage.getToken();
			if (!token) return;

			let cancelled = false;
			const expiresAt = getExpiration(token);

			const hydrate = async () => {
				// Token already expired: refresh if we can, otherwise clear + show login.
				if (expiresAt !== null && Date.now() >= expiresAt) {
					if (options.refreshSession) {
						try {
							const session = await options.refreshSession();
							if (!cancelled) applySession(session);
							return;
						} catch {
							// fall through to clear
						}
					}
					options.tokenStorage.clearToken();
					options.onLogoutCleanup?.();
					if (!cancelled) resetState();
					return;
				}

				try {
					const session = await options.loadSession();
					if (!cancelled) applySession(session);
				} catch {
					options.tokenStorage.clearToken();
					options.onLogoutCleanup?.();
					if (!cancelled) resetState();
				}
			};

			void hydrate();
			return () => {
				cancelled = true;
			};
		}, [applySession, resetState]);

		// --- Task 3.2: expiry warning + proactive auto-refresh -----------------
		const sessionExpiresAt: number | null = state.sessionExpiresAt;
		const sessionExpiringSoon: boolean = state.sessionExpiringSoon;
		const isAuthenticated = Boolean(state.user);

		useEffect(() => {
			if (sessionExpiresAt === null || !isAuthenticated) return;

			const { warnInMs, refreshInMs } = computeExpirySchedule(
				sessionExpiresAt,
				Date.now(),
				{
					autoRefreshLeadMs,
					expiryWarningLeadMs,
					alreadyWarned: sessionExpiringSoon,
				},
			);
			const timers: ReturnType<typeof setTimeout>[] = [];

			if (warnInMs !== null) {
				const fireWarning = () => {
					setState((current: any) => ({
						...current,
						sessionExpiringSoon: true,
					}));
					options.onSessionExpiringSoon?.(sessionExpiresAt);
				};
				if (warnInMs === 0) fireWarning();
				else timers.push(setTimeout(fireWarning, warnInMs));
			}

			if (refreshInMs !== null) {
				if (refreshInMs === 0) void refresh();
				else timers.push(setTimeout(() => void refresh(), refreshInMs));
			}

			return () => {
				for (const timer of timers) clearTimeout(timer);
			};
		}, [sessionExpiresAt, sessionExpiringSoon, isAuthenticated, refresh]);

		// --- Task 3.4: multi-tab synchronization -------------------------------
		useEffect(() => {
			const target = resolveStorageTarget();
			if (!target) return;

			const handler = (event: StorageEvent) => {
				// storage.clear() fires with key === null; otherwise ignore keys
				// that aren't our access token.
				if (event.key !== null && event.key !== tokenStorageKey) return;

				const token = options.tokenStorage.getToken();
				if (!token) {
					// Logged out in another tab: local cleanup only (no API call).
					options.onLogoutCleanup?.();
					resetState();
					return;
				}

				// Logged in / refreshed in another tab: re-hydrate this tab.
				options
					.loadSession()
					.then(applySession)
					.catch(() => {
						options.tokenStorage.clearToken();
						options.onLogoutCleanup?.();
						resetState();
					});
			};

			target.addEventListener("storage", handler);
			return () => target.removeEventListener("storage", handler);
		}, [applySession, resetState]);

		// --- Task 3.3 (reactive): local logout for the transport layer ---------
		// A mid-session request whose token refresh fails is a terminal 401. The
		// API client routes that here via the registered unauthorized handler.
		// callApi:false so we never re-POST /auth/logout (that would 401 and loop
		// back through the same path); clearing state makes RequireAuth redirect.
		useEffect(() => {
			requestLocalLogout = () => {
				void performLogout({ callApi: false });
			};
			return () => {
				requestLocalLogout = null;
			};
		}, [performLogout]);

		const login = useCallback(
			async (email: string, password: string) => {
				setPartialState({ error: null, loading: true });
				try {
					const response = await options.login(email, password);
					options.tokenStorage.setToken(response.token);

					const session = options.hydrateAfterLogin
						? await options.hydrateAfterLogin(response)
						: ({ user: response.user, ...initialExtraState } as AuthSession<
								TUser,
								TExtra
							>);

					applySession(session);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Login failed";
					setPartialState({ error: message, loading: false });
					throw error;
				}
			},
			[applySession, initialExtraState, setPartialState],
		);

		const signup = useCallback(
			async (email: string, password: string, name?: string) => {
				setPartialState({ error: null, loading: true });
				try {
					const response = await options.signup(email, password, name);
					options.tokenStorage.setToken(response.token);

					const session = options.hydrateAfterSignup
						? await options.hydrateAfterSignup(response)
						: ({ user: response.user, ...initialExtraState } as AuthSession<
								TUser,
								TExtra
							>);

					applySession(session);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Signup failed";
					setPartialState({ error: message, loading: false });
					throw error;
				}
			},
			[applySession, initialExtraState, setPartialState],
		);

		return {
			...state,
			login,
			signup,
			logout,
			refresh,
		} as AuthState;
	}

	function AuthProvider({ children }: { children: ReactNode }) {
		const auth = useAuthState();
		return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
	}

	function RequireAuth({
		children,
		loadingFallback = null,
		redirectTo = "/login",
	}: {
		children: ReactNode;
		loadingFallback?: ReactNode;
		redirectTo?: string;
	}) {
		const auth = useAuth();
		const location = useLocation();

		if (auth.loading) return <>{loadingFallback}</>;
		if (!auth.user) {
			return <Navigate to={redirectTo} state={{ from: location }} replace />;
		}

		return <>{children}</>;
	}

	return {
		AuthContext,
		AuthProvider,
		RequireAuth,
		useAuth,
		useAuthState,
		expireSession,
	};
}

export { decodeJwtPayload, getTokenExpiration, isTokenExpired } from "./jwt";
export {
	computeExpirySchedule,
	type ExpirySchedule,
	type ExpiryScheduleInput,
} from "./schedule";
export type { AuthResponse, AuthSession };
export { AuthApiError };
