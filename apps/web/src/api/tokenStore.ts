/**
 * Storage for the access + refresh token pair.
 *
 * The access-token half implements `AuthTokenStorage` from `@onlooker/auth-react`
 * so it can be handed directly to `createAuthApiClient`/`createReactAuth`, while
 * the refresh token is managed alongside it for the refresh middleware.
 */

import type { AuthTokenStorage } from "@onlooker/auth-react";
import type { AuthTokens } from "./types";

export interface TokenStore extends AuthTokenStorage {
	getRefreshToken(): string | null;
	setRefreshToken(token: string): void;
	clearRefreshToken(): void;
	/** Store both tokens atomically (e.g. after login or refresh). */
	setTokens(tokens: { accessToken: string; refreshToken: string }): void;
	/** Read the current pair. */
	getTokens(): AuthTokens;
	/** Remove both tokens (logout / unrecoverable auth failure). */
	clear(): void;
}

function safeStorage(): Storage | null {
	try {
		return typeof window !== "undefined" ? window.localStorage : null;
	} catch {
		return null;
	}
}

export function createTokenStore(
	accessKey: string,
	refreshKey: string,
	storage: Storage | null = safeStorage(),
): TokenStore {
	const read = (key: string): string | null => {
		if (!storage) return null;
		try {
			return storage.getItem(key);
		} catch {
			return null;
		}
	};

	const write = (key: string, value: string): void => {
		if (!storage) return;
		try {
			storage.setItem(key, value);
		} catch {
			// Storage full or unavailable — fail silently, session stays in-memory.
		}
	};

	const remove = (key: string): void => {
		if (!storage) return;
		try {
			storage.removeItem(key);
		} catch {
			// Ignore.
		}
	};

	return {
		getToken: () => read(accessKey),
		setToken: (token) => write(accessKey, token),
		clearToken: () => remove(accessKey),
		getRefreshToken: () => read(refreshKey),
		setRefreshToken: (token) => write(refreshKey, token),
		clearRefreshToken: () => remove(refreshKey),
		setTokens: ({ accessToken, refreshToken }) => {
			write(accessKey, accessToken);
			write(refreshKey, refreshToken);
		},
		getTokens: () => ({
			accessToken: read(accessKey),
			refreshToken: read(refreshKey),
		}),
		clear: () => {
			remove(accessKey);
			remove(refreshKey);
		},
	};
}
