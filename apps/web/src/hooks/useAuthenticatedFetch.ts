import { useCallback, useEffect, useState } from "react";
// WS1's client owns transport resilience: it injects the Authorization header,
// retries transient failures (429/5xx/network/timeout) with exponential backoff
// + jitter, and refreshes the session once on 401 before replaying the request.
// This hook deliberately does NOT re-implement any of that — it only owns the
// React data-fetching lifecycle so components never touch tokens or fetch state.
import { apiClient } from "../api/client";

export interface UseAuthenticatedFetchOptions {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	body?: unknown;
	/** When true, the request is not issued (e.g. waiting on a dependency). */
	skip?: boolean;
}

export interface UseAuthenticatedFetchResult<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	/** Re-issue the request (e.g. a "Retry" button after an error). */
	refetch: () => void;
}

/**
 * Fetches a protected resource through WS1's authenticated API client. Any 401
 * that survives to the caller means the session is unrecoverable (refresh
 * already failed); the error is surfaced and the global unauthorized handler
 * drives logout/redirect.
 */
export function useAuthenticatedFetch<T>(
	path: string,
	options: UseAuthenticatedFetchOptions = {},
): UseAuthenticatedFetchResult<T> {
	const { method = "GET", body, skip = false } = options;

	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState<boolean>(!skip);
	const [error, setError] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const bodyKey = body === undefined ? undefined : JSON.stringify(body);

	useEffect(() => {
		if (skip) {
			setLoading(false);
			return;
		}

		let active = true;
		setLoading(true);
		setError(null);

		const parsedBody = bodyKey === undefined ? undefined : JSON.parse(bodyKey);

		apiClient
			.request<T>(method, path, parsedBody)
			.then((result: T) => {
				if (active) setData(result);
			})
			.catch((err: unknown) => {
				if (active) {
					setError(err instanceof Error ? err.message : "Request failed");
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});

		return () => {
			active = false;
		};
	}, [path, method, bodyKey, skip, reloadToken]);

	const refetch = useCallback(() => {
		setReloadToken((token) => token + 1);
	}, []);

	return { data, loading, error, refetch };
}
