import { describe, expect, it, vi } from "vitest";
import {
	createRateLimiter,
	formatRetryAfter,
	type SuspiciousActivity,
} from "./rateLimiting";

/**
 * Build a limiter driven by a controllable clock so tests never touch real time.
 * Returns the limiter plus an `advance` helper.
 */
function withClock(
	overrides: Parameters<typeof createRateLimiter>[0] = {},
	start = 1_000_000,
) {
	let t = start;
	const now = () => t;
	const limiter = createRateLimiter({ ...overrides, now });
	return { limiter, advance: (ms: number) => (t += ms), now };
}

describe("createRateLimiter", () => {
	it("permits attempts up to the configured maximum", () => {
		const { limiter } = withClock({ maxAttempts: 5 });
		expect(limiter.check("a").allowed).toBe(true);
		expect(limiter.check("a").remaining).toBe(5);
		for (let i = 0; i < 5; i++) limiter.record("a");
		expect(limiter.isLocked("a")).toBe(false);
		expect(limiter.check("a").remaining).toBe(0);
	});

	it("locks out on the attempt past the maximum", () => {
		const onLockout = vi.fn();
		const { limiter } = withClock({
			maxAttempts: 5,
			lockoutMs: 60_000,
			onLockout,
		});
		for (let i = 0; i < 6; i++) limiter.record("a");
		expect(limiter.isLocked("a")).toBe(true);
		expect(limiter.check("a").allowed).toBe(false);
		expect(limiter.check("a").retryAfterMs).toBe(60_000);
		expect(onLockout).toHaveBeenCalledTimes(1);
		const info = onLockout.mock.calls[0][0] as SuspiciousActivity;
		expect(info.key).toBe("a");
	});

	it("clears the lockout once the timeout elapses", () => {
		const { limiter, advance } = withClock({
			maxAttempts: 5,
			lockoutMs: 60_000,
		});
		for (let i = 0; i < 6; i++) limiter.record("a");
		expect(limiter.isLocked("a")).toBe(true);
		advance(60_001);
		expect(limiter.isLocked("a")).toBe(false);
		expect(limiter.check("a").allowed).toBe(true);
	});

	it("ages out attempts outside the sliding window", () => {
		const { limiter, advance } = withClock({
			maxAttempts: 5,
			windowMs: 60_000,
		});
		limiter.record("a");
		limiter.record("a");
		expect(limiter.check("a").remaining).toBe(3);
		advance(61_000);
		expect(limiter.check("a").remaining).toBe(5);
	});

	it("resets a key on success", () => {
		const { limiter } = withClock();
		limiter.record("a");
		limiter.record("a");
		limiter.reset("a");
		expect(limiter.check("a").remaining).toBe(5);
	});

	it("tracks keys independently", () => {
		const { limiter } = withClock({ maxAttempts: 5 });
		for (let i = 0; i < 6; i++) limiter.record("locked");
		expect(limiter.isLocked("locked")).toBe(true);
		expect(limiter.isLocked("other")).toBe(false);
	});

	it("does not extend an active lockout on further attempts", () => {
		const { limiter, advance } = withClock({
			maxAttempts: 5,
			lockoutMs: 60_000,
		});
		for (let i = 0; i < 6; i++) limiter.record("a");
		advance(30_000);
		limiter.record("a");
		expect(limiter.check("a").retryAfterMs).toBe(30_000);
	});
});

describe("formatRetryAfter", () => {
	it("formats sub-minute and minute durations", () => {
		expect(formatRetryAfter(0)).toBe("now");
		expect(formatRetryAfter(1000)).toBe("in 1 second");
		expect(formatRetryAfter(45_000)).toBe("in 45 seconds");
		expect(formatRetryAfter(60_000)).toBe("in 1 minute");
		expect(formatRetryAfter(120_000)).toBe("in 2 minutes");
	});
});
