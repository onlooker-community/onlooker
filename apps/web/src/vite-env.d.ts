interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string;
	readonly VITE_USE_MOCK_API?: string;
	readonly VITE_API_TIMEOUT_MS?: string;
	readonly VITE_API_MAX_RETRIES?: string;
	readonly VITE_API_RETRY_BASE_DELAY_MS?: string;
	readonly VITE_API_RETRY_MAX_DELAY_MS?: string;
	readonly VITE_AUTH_TOKEN_KEY?: string;
	readonly VITE_AUTH_REFRESH_KEY?: string;
	readonly VITE_API_LOG_REQUESTS?: string;
	readonly MODE?: string;
	readonly DEV?: boolean;
	readonly PROD?: boolean;
	readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
	/**
	 * Declared narrowly here rather than by pulling in `vite/client`, whose
	 * ImportMetaEnv conflicts with the hand-rolled one above on MODE's
	 * optionality.
	 */
	glob<T = unknown>(
		pattern: string,
		options?: { eager?: boolean; query?: string; import?: string },
	): Record<string, T>;
}
