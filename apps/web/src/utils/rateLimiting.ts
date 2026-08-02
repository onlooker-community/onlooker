/**
 * Client-side rate limiting for authentication attempts.
 *
 * This is a UX and abuse-slowing guard, not a security boundary — a determined
 * attacker can bypass anything running in the browser. The server must enforce
 * its own limits. Purpose here: stop accidental credential-stuffing from the UI,
 * surface a clear lockout message, and emit a hook for suspicious-activity logging.
 *
 * The clock is injectable (`now`) so behavior is deterministic under test.
 */

export interface RateLimiterOptions {
	/** Attempts permitted inside `windowMs` before lockout. Default 5. */
	maxAttempts?: number;
	/** Sliding window over which attempts are counted, in ms. Default 60_000. */
	windowMs?: number;
	/** How long a lockout lasts once triggered, in ms. Default 60_000. */
	lockoutMs?: number;
	/** Time source; override in tests. Default `Date.now`. */
	now?: () => number;
	/** Invoked when a key crosses into lockout — wire to your logger. */
	onLockout?: (info: SuspiciousActivity) => void;
}

export interface SuspiciousActivity {
	key: string;
	attempts: number;
	lockedUntil: number;
	at: number;
}

export interface RateLimitState {
	/** Whether a new attempt is currently permitted for this key. */
	allowed: boolean;
	/** Attempts remaining before lockout (0 when locked). */
	remaining: number;
	/** ms until the caller may retry; 0 when not locked. */
	retryAfterMs: number;
}

interface KeyRecord {
	timestamps: number[];
	lockedUntil: number;
}

const DEFAULTS = {
	maxAttempts: 5,
	windowMs: 60_000,
	lockoutMs: 60_000,
} as const;

export function createRateLimiter(options: RateLimiterOptions = {}) {
	const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
	const windowMs = options.windowMs ?? DEFAULTS.windowMs;
	const lockoutMs = options.lockoutMs ?? DEFAULTS.lockoutMs;
	const now = options.now ?? (() => Date.now());

	const records = new Map<string, KeyRecord>();

	function getRecord(key: string): KeyRecord {
		let record = records.get(key);
		if (!record) {
			record = { timestamps: [], lockedUntil: 0 };
			records.set(key, record);
		}
		return record;
	}

	function prune(record: KeyRecord, at: number): void {
		const cutoff = at - windowMs;
		record.timestamps = record.timestamps.filter((t) => t > cutoff);
	}

	function stateOf(record: KeyRecord, at: number): RateLimitState {
		if (record.lockedUntil > at) {
			return {
				allowed: false,
				remaining: 0,
				retryAfterMs: record.lockedUntil - at,
			};
		}
		return {
			allowed: true,
			remaining: Math.max(0, maxAttempts - record.timestamps.length),
			retryAfterMs: 0,
		};
	}

	return {
		/** Inspect current state for a key without recording an attempt. */
		check(key: string): RateLimitState {
			const at = now();
			const record = getRecord(key);
			prune(record, at);
			return stateOf(record, at);
		},

		/** True when the key is currently locked out. */
		isLocked(key: string): boolean {
			return now() < getRecord(key).lockedUntil;
		},

		/**
		 * Record one failed attempt for a key. When the count exceeds the
		 * allowance within the window, the key is locked and `onLockout` fires.
		 * Returns the resulting state.
		 */
		record(key: string): RateLimitState {
			const at = now();
			const record = getRecord(key);

			if (record.lockedUntil > at) {
				return stateOf(record, at);
			}

			prune(record, at);
			record.timestamps.push(at);

			if (record.timestamps.length > maxAttempts) {
				record.lockedUntil = at + lockoutMs;
				record.timestamps = [];
				options.onLockout?.({
					key,
					attempts: maxAttempts + 1,
					lockedUntil: record.lockedUntil,
					at,
				});
			}

			return stateOf(record, at);
		},

		/** Clear all state for a key — call on a successful login. */
		reset(key: string): void {
			records.delete(key);
		},

		/** Clear all tracked keys. */
		clear(): void {
			records.clear();
		},
	};
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * Format a retry delay as a short human string for lockout messaging,
 * e.g. "in 45 seconds" or "in 2 minutes".
 */
export function formatRetryAfter(retryAfterMs: number): string {
	const seconds = Math.ceil(retryAfterMs / 1000);
	if (seconds <= 0) return "now";
	if (seconds < 60) return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
	const minutes = Math.ceil(seconds / 60);
	return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
