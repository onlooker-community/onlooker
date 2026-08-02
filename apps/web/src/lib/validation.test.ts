import { describe, expect, it } from "vitest";
import {
	getPasswordChecks,
	isValidEmail,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	scorePassword,
	validateEmail,
	validatePassword,
	validatePasswordMatch,
} from "./validation";

describe("email validation", () => {
	it("accepts well-formed addresses and trims whitespace", () => {
		expect(isValidEmail("a@b.co")).toBe(true);
		expect(isValidEmail("  user@example.com  ")).toBe(true);
	});

	it("rejects malformed addresses", () => {
		expect(isValidEmail("nope")).toBe(false);
		expect(isValidEmail("a@b")).toBe(false);
		expect(isValidEmail("a b@c.com")).toBe(false);
	});

	it("returns a message for empty and invalid input, null when valid", () => {
		expect(validateEmail("")).toBe("Email is required.");
		expect(validateEmail("nope")).toBe("Enter a valid email address.");
		expect(validateEmail("user@example.com")).toBeNull();
	});
});

describe("getPasswordChecks", () => {
	it("reports each rule independently", () => {
		const checks = getPasswordChecks("Str0ng!Pass");
		expect(checks).toEqual({
			minLength: true,
			hasLower: true,
			hasUpper: true,
			hasNumber: true,
			hasSymbol: true,
			notCommon: true,
		});
	});

	it("flags a common password as not passing notCommon", () => {
		expect(getPasswordChecks("password123").notCommon).toBe(false);
	});

	it("flags a short lowercase-only password", () => {
		const checks = getPasswordChecks("abc");
		expect(checks.minLength).toBe(false);
		expect(checks.hasUpper).toBe(false);
		expect(checks.hasNumber).toBe(false);
		expect(checks.hasSymbol).toBe(false);
	});
});

describe("scorePassword", () => {
	it("scores the empty string as zero and not meeting requirements", () => {
		const s = scorePassword("");
		expect(s.score).toBe(0);
		expect(s.label).toBe("Empty");
		expect(s.meetsRequirements).toBe(false);
		expect(s.suggestions.length).toBeGreaterThan(0);
	});

	it("caps common passwords at a low score", () => {
		const s = scorePassword("password123");
		expect(s.score).toBeLessThanOrEqual(1);
		expect(s.meetsRequirements).toBe(false);
		expect(s.suggestions.some((t) => t.toLowerCase().includes("common"))).toBe(
			true,
		);
	});

	it("marks a strong all-class password as meeting requirements", () => {
		const s = scorePassword("Str0ng!Passw0rd");
		expect(s.meetsRequirements).toBe(true);
		expect(s.score).toBeGreaterThanOrEqual(3);
	});

	it("rewards longer, more diverse passwords with a higher score", () => {
		expect(scorePassword("abcdefgh").score).toBeLessThan(
			scorePassword("Abcdef1!ghij").score,
		);
	});
});

describe("validatePassword", () => {
	it("requires a password", () => {
		expect(validatePassword("")).toBe("Password is required.");
	});

	it("enforces the minimum length", () => {
		expect(validatePassword("Aa1!")).toBe(
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
		);
	});

	it("enforces the maximum length", () => {
		expect(validatePassword("Aa1!".repeat(MAX_PASSWORD_LENGTH))).toBe(
			`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
		);
	});

	it("rejects common passwords", () => {
		expect(validatePassword("password123")).toMatch(/too common/i);
	});

	it("accepts an acceptable password", () => {
		expect(validatePassword("Str0ng!Passw0rd")).toBeNull();
	});
});

describe("validatePasswordMatch", () => {
	it("requires a confirmation", () => {
		expect(validatePasswordMatch("secret", "")).toBe(
			"Please confirm your password.",
		);
	});

	it("rejects a mismatch", () => {
		expect(validatePasswordMatch("secret", "other")).toBe(
			"Passwords do not match.",
		);
	});

	it("accepts a match", () => {
		expect(validatePasswordMatch("secret", "secret")).toBeNull();
	});
});
