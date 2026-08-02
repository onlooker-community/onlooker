import {
	AuthApiError,
	type AuthResponse,
	type AuthSession,
} from "@onlooker/auth-core";
import { createContext, useContext } from "react";

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
}

export type ReactAuthState<TUser, TExtra extends object> = {
	user: TUser | null;
	loading: boolean;
	error: string | null;
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

	function useAuth(): AuthState {
		const context = useContext(AuthContext);
		if (!context) {
			throw new Error("useAuth must be used within AuthProvider");
		}
		return context;
	}

	function useAuthState(): AuthState {
		const initialExtraState = useMemo(() => options.initialState, []);
		const [state, setState] = useState<any>({
			user: null,
			loading: Boolean(options.tokenStorage.getToken()),
			error: null,
			...initialExtraState,
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
			}));
		}, []);

		const resetState = useCallback(() => {
			setState({
				user: null,
				loading: false,
				error: null,
				...initialExtraState,
			});
		}, [initialExtraState]);

		useEffect(() => {
			if (!options.tokenStorage.getToken()) return;

			options
				.loadSession()
				.then(applySession)
				.catch(() => {
					options.tokenStorage.clearToken();
					resetState();
				});
		}, [applySession, resetState]);

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

		const logout = useCallback(async () => {
			options.tokenStorage.clearToken();
			await options.logout?.();
			resetState();
		}, [resetState]);

		const refresh = useCallback(async () => {
			try {
				const session = options.refreshSession
					? await options.refreshSession()
					: await options.loadSession();
				applySession(session);
			} catch {
				await logout();
			}
		}, [applySession, logout]);

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
	};
}

export type { AuthResponse, AuthSession };
export { AuthApiError };
