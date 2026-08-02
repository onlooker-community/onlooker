import { AuthApiError, type AuthResponse, type AuthSession } from "@onlooker/auth-core";
import type React from "react";
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
	storage: Storage = typeof window !== "undefined" ? window.localStorage : (undefined as any),
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
	const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
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
				(data as any).message ?? `Request failed with status ${response.status}`,
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
// Auth Context & Provider (Placeholder)
// ============================================================================

// Full implementation in Task 3 (createReactAuth factory)
export const AuthContext = createContext<any>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	return <>{children}</>;
}

export function useAuth() {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within AuthProvider");
	}
	return context;
}

export type { AuthApiError };
export type { AuthResponse, AuthSession };
