import {
	AuthApiError,
	type AuthResponse,
	type AuthSession,
} from "@onlooker/auth-core";
import { createContext, useContext } from "react";
import { getTokenExpiration as defaultGetTokenExpiration } from "./jwt";
import { computeExpirySchedule } from "./schedule";
import { isSessionGone, parseRetryAfter, retryDelayMs } from "./transient";

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
			// apps/api wraps every error through a shared errorHandler as
			// { success: false, error: { code, message, details } }. Reading
			// `data.error` as the code - which this did - yields an OBJECT
			// against the real API and a string against a mock, so a check like
			// `err.code === "not_found"` passed in development and failed in
			// production. The narrow type below is deliberate: the `as any` that
			// used to be here is what let the two shapes go unnoticed.
			const envelope = (data ?? {}) as {
				error?: { code?: string; message?: string; details?: unknown };
			};
			throw new AuthApiError(
				response.status,
				typeof envelope.error?.code === "string"
					? envelope.error.code
					: "unknown_error",
				envelope.error?.message ??
					`Request failed with status ${response.status}`,
				envelope.error?.details,
				parseRetryAfter(response.headers.get("Retry-After"), Date.now()),
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
	useRef,
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
	/**
	 * Set when the last session check failed for a reason other than a 401
	 * and a retry is scheduled. The tokens are kept; RequireAuth renders its
	 * unavailableFallback instead of redirecting (ONL-243).
	 */
	unavailable: { retryAt: number } | null;
} & TExtra & {
		login: (email: string, password: string) => Promise<void>;
		signup: (email: string, password: string, name?: string) => Promise<void>;
		logout: () => Promise<void>;
		refresh: () => Promise<void>;
		retrySession: () => void;
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
				unavailable: null,
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
				unavailable: null,
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
				unavailable: null,
				sessionExpiresAt: null,
				sessionExpiringSoon: false,
			});
		}, [initialExtraState]);

		// --- ONL-243: a session that is unreachable, not gone -------------------
		// One timer for hydrate, the proactive refresh and the cross-tab
		// re-hydrate: whichever retry is pending, a newer one supersedes it.
		const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
		const failures = useRef(0);
		const mounted = useRef(true);

		// ONL-246: which settling of the session is current. A check notes it
		// when it starts and acts on its answer only if nothing has settled the
		// session since - a logout, a login, or another check's success.
		// Without it, a refresh still in flight at logout put the user back,
		// and a stale refusal signed out a session that had just refreshed.
		const generation = useRef(0);
		const settle = () => {
			generation.current += 1;
		};
		const isCurrent = (started: number) =>
			mounted.current && started === generation.current;

		const clearRetry = useCallback(() => {
			if (retryTimer.current) {
				clearTimeout(retryTimer.current);
				retryTimer.current = null;
			}
		}, []);

		useEffect(() => {
			mounted.current = true;
			return () => {
				mounted.current = false;
				clearRetry();
			};
		}, [clearRetry]);

		// A failure that leaves no token behind is a sign-out, whatever was
		// thrown: the web app's refreshSession throws a plain Error both when the
		// refresh was rejected (and it cleared the tokens) and when it was only
		// unreachable.
		const sessionGone = useCallback(
			(error: unknown) =>
				isSessionGone(error) || !options.tokenStorage.getToken(),
			[],
		);

		const scheduleRetry = useCallback(
			(error: unknown, rerun: () => void, visible: boolean) => {
				const delay = retryDelayMs(error, failures.current);
				failures.current += 1;
				clearRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					rerun();
				}, delay);
				if (visible) {
					setPartialState({
						loading: false,
						unavailable: { retryAt: Date.now() + delay },
					});
				}
			},
			[clearRetry, setPartialState],
		);

		const succeed = useCallback(
			(session: AuthSession<TUser, TExtra>) => {
				settle();
				failures.current = 0;
				clearRetry();
				applySession(session);
			},
			[applySession, clearRetry],
		);

		const clearLocalSession = useCallback(() => {
			settle();
			failures.current = 0;
			clearRetry();
			options.tokenStorage.clearToken();
			options.onLogoutCleanup?.();
			resetState();
		}, [clearRetry, resetState]);

		// --- Task 3.3: logout with API-first cleanup ---------------------------
		// Call the logout endpoint while the token is still present so the server
		// can invalidate the session, THEN clear local storage and run extra
		// cleanup (refresh token, in-flight request abort). `callApi: false` is
		// used for reactive logouts (failed refresh, cross-tab) where hitting the
		// endpoint again would be redundant or loop.
		const performLogout = useCallback(
			async ({ callApi }: { callApi: boolean }) => {
				// Before the API call, not after: a check that lands while the
				// logout request is out is already stale.
				settle();
				failures.current = 0;
				clearRetry();
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
			[clearRetry, resetState],
		);

		const logout = useCallback(
			() => performLogout({ callApi: true }),
			[performLogout],
		);

		const refresh = useCallback(async () => {
			const started = generation.current;
			try {
				const session = options.refreshSession
					? await options.refreshSession()
					: await options.loadSession();
				if (isCurrent(started)) succeed(session);
			} catch (error) {
				if (!isCurrent(started)) return;
				// Task 3.2: a refresh the server refused forces re-login. Local-only
				// cleanup, since the refusal already proved the session is gone.
				if (sessionGone(error)) {
					await performLogout({ callApi: false });
					return;
				}
				// Anything else: the person is signed in and the access token is still
				// good for a while, so retry quietly (ONL-243).
				scheduleRetry(error, () => void refreshRef.current(), false);
			}
		}, [succeed, sessionGone, performLogout, scheduleRetry]);
		const refreshRef = useRef(refresh);
		refreshRef.current = refresh;

		// --- Task 3.1: session hydration on app load ---------------------------
		const hydrate = useCallback(async (): Promise<void> => {
			const token = options.tokenStorage.getToken();
			if (!token) return;
			const expiresAt = getExpiration(token);
			const expired = expiresAt !== null && Date.now() >= expiresAt;

			// Token already expired with no way to refresh it: nothing to retry.
			if (expired && !options.refreshSession) {
				clearLocalSession();
				return;
			}

			const started = generation.current;
			try {
				const session =
					expired && options.refreshSession
						? await options.refreshSession()
						: await options.loadSession();
				if (isCurrent(started)) succeed(session);
			} catch (error) {
				if (!isCurrent(started)) return;
				if (sessionGone(error)) {
					clearLocalSession();
					return;
				}
				scheduleRetry(error, () => void hydrateRef.current(), true);
			}
		}, [clearLocalSession, succeed, sessionGone, scheduleRetry]);
		const hydrateRef = useRef(hydrate);
		hydrateRef.current = hydrate;

		useEffect(() => {
			void hydrateRef.current();
		}, []);

		const retrySession = useCallback(() => {
			clearRetry();
			void hydrateRef.current();
		}, [clearRetry]);

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
					// Forget any pending retry too, or it fires against no session.
					settle();
					failures.current = 0;
					clearRetry();
					options.onLogoutCleanup?.();
					resetState();
					return;
				}

				// Logged in / refreshed in another tab: re-hydrate this tab.
				const started = generation.current;
				options
					.loadSession()
					.then((session) => {
						if (isCurrent(started)) succeed(session);
					})
					.catch((error: unknown) => {
						if (!isCurrent(started)) return;
						if (sessionGone(error)) {
							clearLocalSession();
							return;
						}
						scheduleRetry(error, () => void hydrateRef.current(), true);
					});
			};

			target.addEventListener("storage", handler);
			return () => target.removeEventListener("storage", handler);
		}, [
			succeed,
			sessionGone,
			clearLocalSession,
			scheduleRetry,
			clearRetry,
			resetState,
		]);

		// --- Task 3.3 (reactive): local logout for the transport layer ---------
		// A mid-session request whose token refresh is refused is a terminal 401
		// (an unreachable refresh is not: it keeps the session). The
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

					succeed(session);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Login failed";
					setPartialState({ error: message, loading: false });
					throw error;
				}
			},
			[succeed, initialExtraState, setPartialState],
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

					succeed(session);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Signup failed";
					setPartialState({ error: message, loading: false });
					throw error;
				}
			},
			[succeed, initialExtraState, setPartialState],
		);

		return {
			...state,
			login,
			signup,
			logout,
			refresh,
			retrySession,
		} as AuthState;
	}

	function AuthProvider({ children }: { children: ReactNode }) {
		const auth = useAuthState();
		return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
	}

	function RequireAuth({
		children,
		loadingFallback = null,
		unavailableFallback,
		redirectTo = "/login",
	}: {
		children: ReactNode;
		loadingFallback?: ReactNode;
		/**
		 * What to show while the session can't be checked but hasn't been
		 * refused - a 429, a 5xx, offline. Without one, the loading fallback
		 * shows instead: never a redirect, which would treat an unreachable
		 * session as a gone one (ONL-243).
		 */
		unavailableFallback?: (state: {
			retryAt: number;
			retry: () => void;
		}) => ReactNode;
		redirectTo?: string;
	}) {
		const auth = useAuth();
		const location = useLocation();

		if (auth.loading) return <>{loadingFallback}</>;
		if (!auth.user && auth.unavailable) {
			return (
				<>
					{unavailableFallback
						? unavailableFallback({
								retryAt: auth.unavailable.retryAt,
								retry: auth.retrySession,
							})
						: loadingFallback}
				</>
			);
		}
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
export {
	isSessionGone,
	MAX_RETRY_MS,
	MIN_RETRY_MS,
	parseRetryAfter,
	RETRY_BACKOFF_MS,
	retryDelayMs,
} from "./transient";
export type { AuthResponse, AuthSession };
export { AuthApiError };
