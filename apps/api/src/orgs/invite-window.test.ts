import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_INVITE_EXPIRY_DAYS,
	resolveInviteWindow,
} from "./invite-window.js";

const env = (value?: string) =>
	({ INVITE_EXPIRY_DAYS: value }) as { INVITE_EXPIRY_DAYS?: string };

describe("resolveInviteWindow", () => {
	it("reads a configured value", () => {
		expect(resolveInviteWindow(env("3")).days).toBe(3);
		expect(resolveInviteWindow(env("3")).ms).toBe(3 * 24 * 60 * 60 * 1000);
	});

	// Every one of these produces a number from Number() without throwing, and
	// a window of 0 or NaN means every invite is born expired - a flow that
	// fails silently for everybody. onlooker-nsow87 is an open bug of exactly
	// this shape, where a typo'd var name yields a monitor that is green
	// forever.
	it.each([
		["unset", undefined],
		["empty", ""],
		["not a number", "seven"],
		["zero", "0"],
		["negative", "-5"],
		["fractional", "1.5"],
	])("falls back to the default when %s", (_label, value) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveInviteWindow(env(value)).days).toBe(
			DEFAULT_INVITE_EXPIRY_DAYS,
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does not warn when the value is good", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		resolveInviteWindow(env("7"));
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
