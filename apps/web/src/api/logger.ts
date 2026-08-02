/**
 * Console logging for API calls with strict redaction of sensitive material.
 *
 * Tokens, passwords, and Authorization headers are never written to the log —
 * neither from request bodies, headers, nor URL query strings.
 */

const REDACTED = "[redacted]";

const SENSITIVE_KEYS = new Set([
	"authorization",
	"token",
	"accesstoken",
	"access_token",
	"refreshtoken",
	"refresh_token",
	"password",
	"new_password",
	"current_password",
]);

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEYS.has(key.toLowerCase());
}

/** Deep-clone a value, replacing any sensitive fields with a redacted marker. */
export function redact(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redact);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			out[key] = isSensitiveKey(key) ? REDACTED : redact(val);
		}
		return out;
	}
	return value;
}

/** Return a URL with any sensitive query parameters redacted. */
export function safeUrl(url: string): string {
	try {
		const parsed = new URL(url, "http://local");
		let mutated = false;
		for (const key of [...parsed.searchParams.keys()]) {
			if (isSensitiveKey(key)) {
				parsed.searchParams.set(key, REDACTED);
				mutated = true;
			}
		}
		if (!mutated) return url;
		return url.startsWith("http")
			? parsed.toString()
			: parsed.pathname + parsed.search;
	} catch {
		return url;
	}
}

export interface ApiLogEntry {
	method: string;
	url: string;
	status?: number;
	durationMs?: number;
	attempt?: number;
	error?: string;
}

export interface ApiLogger {
	request(entry: ApiLogEntry): void;
	success(entry: ApiLogEntry): void;
	failure(entry: ApiLogEntry): void;
}

const noopLogger: ApiLogger = {
	request: () => {},
	success: () => {},
	failure: () => {},
};

function format(entry: ApiLogEntry): string {
	const parts = [`${entry.method} ${safeUrl(entry.url)}`];
	if (entry.status !== undefined) parts.push(`→ ${entry.status}`);
	if (entry.durationMs !== undefined)
		parts.push(`(${Math.round(entry.durationMs)}ms)`);
	if (entry.attempt !== undefined && entry.attempt > 0) {
		parts.push(`[retry ${entry.attempt}]`);
	}
	if (entry.error) parts.push(`error=${entry.error}`);
	return parts.join(" ");
}

export function createApiLogger(enabled: boolean): ApiLogger {
	if (!enabled) return noopLogger;
	return {
		request: (entry) => console.debug(`[api] ${format(entry)}`),
		success: (entry) => console.debug(`[api] ${format(entry)}`),
		failure: (entry) => console.warn(`[api] ${format(entry)}`),
	};
}
