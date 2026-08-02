import { describe, expect, it } from "vitest";
import { computeExpirySchedule } from "./schedule";

const leads = { autoRefreshLeadMs: 60_000, expiryWarningLeadMs: 300_000 };

describe("computeExpirySchedule", () => {
	it("schedules nothing when expiry is unknown", () => {
		expect(
			computeExpirySchedule(null, 0, { ...leads, alreadyWarned: false }),
		).toEqual({ warnInMs: null, refreshInMs: null });
	});

	it("schedules warn and refresh relative to expiry", () => {
		const now = 1_000_000;
		const expiresAt = now + 600_000; // 10 min out
		const schedule = computeExpirySchedule(expiresAt, now, {
			...leads,
			alreadyWarned: false,
		});
		// warn 5 min before expiry => 5 min from now; refresh 1 min before => 9 min
		expect(schedule.warnInMs).toBe(300_000);
		expect(schedule.refreshInMs).toBe(540_000);
	});

	it("clamps past deadlines to 0 (act now)", () => {
		const now = 1_000_000;
		const expiresAt = now + 30_000; // 30s out: inside both lead windows
		const schedule = computeExpirySchedule(expiresAt, now, {
			...leads,
			alreadyWarned: false,
		});
		expect(schedule.warnInMs).toBe(0);
		expect(schedule.refreshInMs).toBe(0);
	});

	it("suppresses the warning once already warned, still schedules refresh", () => {
		const now = 1_000_000;
		const expiresAt = now + 600_000;
		const schedule = computeExpirySchedule(expiresAt, now, {
			...leads,
			alreadyWarned: true,
		});
		expect(schedule.warnInMs).toBeNull();
		expect(schedule.refreshInMs).toBe(540_000);
	});

	it("acts now for an already-expired token", () => {
		const now = 1_000_000;
		const expiresAt = now - 1; // already past
		const schedule = computeExpirySchedule(expiresAt, now, {
			...leads,
			alreadyWarned: false,
		});
		expect(schedule.warnInMs).toBe(0);
		expect(schedule.refreshInMs).toBe(0);
	});
});
