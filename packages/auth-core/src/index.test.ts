import { describe, it, expect } from "vitest";
import {
	isUserTokenClaims,
	isMachineTokenClaims,
	parseAuthTokenClaims,
	loginInputSchema,
	signupInputSchema,
	AuthApiError,
} from "./index";

describe("auth-core", () => {
	describe("isUserTokenClaims", () => {
		it("returns true for user token claims", () => {
			const claims = { sub: "user-1", kind: "user" as const };
			expect(isUserTokenClaims(claims)).toBe(true);
		});

		it("returns false for machine token claims", () => {
			const claims = { sub: "machine-1", kind: "machine" as const, machine_id: "m-1" };
			expect(isUserTokenClaims(claims)).toBe(false);
		});
	});

	describe("isMachineTokenClaims", () => {
		it("returns true for machine token claims", () => {
			const claims = { sub: "machine-1", kind: "machine" as const, machine_id: "m-1" };
			expect(isMachineTokenClaims(claims)).toBe(true);
		});

		it("returns false for user token claims", () => {
			const claims = { sub: "user-1", kind: "user" as const };
			expect(isMachineTokenClaims(claims)).toBe(false);
		});

		it("returns false if machine_id is missing", () => {
			const claims = { sub: "machine-1", kind: "machine" as const };
			expect(isMachineTokenClaims(claims)).toBe(false);
		});
	});

	describe("parseAuthTokenClaims", () => {
		it("parses valid user token claims", () => {
			const claims = { sub: "user-1", kind: "user" as const };
			const parsed = parseAuthTokenClaims(claims);
			expect(parsed).toEqual(claims);
		});

		it("parses valid machine token claims", () => {
			const claims = { sub: "machine-1", kind: "machine" as const, machine_id: "m-1" };
			const parsed = parseAuthTokenClaims(claims);
			expect(parsed).toEqual(claims);
		});

		it("throws for invalid claims", () => {
			const claims = { sub: "user-1", kind: "invalid" };
			expect(() => parseAuthTokenClaims(claims)).toThrow();
		});

		it("throws for missing sub", () => {
			const claims = { kind: "user" as const };
			expect(() => parseAuthTokenClaims(claims)).toThrow();
		});
	});

	describe("loginInputSchema", () => {
		it("validates valid login input", () => {
			const input = { email: "user@example.com", password: "password123" };
			expect(loginInputSchema.parse(input)).toEqual(input);
		});

		it("rejects invalid email", () => {
			const input = { email: "not-an-email", password: "password123" };
			expect(() => loginInputSchema.parse(input)).toThrow();
		});

		it("rejects missing password", () => {
			const input = { email: "user@example.com" };
			expect(() => loginInputSchema.parse(input)).toThrow();
		});

		it("allows empty password (min 1 char)", () => {
			const input = { email: "user@example.com", password: "a" };
			expect(loginInputSchema.parse(input)).toEqual(input);
		});
	});

	describe("signupInputSchema", () => {
		it("validates valid signup input with name", () => {
			const input = { email: "user@example.com", password: "password123", name: "Test User" };
			expect(signupInputSchema.parse(input)).toEqual(input);
		});

		it("validates valid signup input without name", () => {
			const input = { email: "user@example.com", password: "password123" };
			expect(signupInputSchema.parse(input)).toEqual(input);
		});

		it("rejects password shorter than 8 chars", () => {
			const input = { email: "user@example.com", password: "short" };
			expect(() => signupInputSchema.parse(input)).toThrow();
		});

		it("rejects password longer than 128 chars", () => {
			const input = { email: "user@example.com", password: "a".repeat(129) };
			expect(() => signupInputSchema.parse(input)).toThrow();
		});

		it("rejects empty name", () => {
			const input = { email: "user@example.com", password: "password123", name: "" };
			expect(() => signupInputSchema.parse(input)).toThrow();
		});
	});

	describe("AuthApiError", () => {
		it("creates error with status, code, message", () => {
			const error = new AuthApiError(401, "unauthorized", "Invalid credentials");
			expect(error.status).toBe(401);
			expect(error.code).toBe("unauthorized");
			expect(error.message).toBe("Invalid credentials");
			expect(error instanceof Error).toBe(true);
		});

		it("includes details if provided", () => {
			const details = { field: "email" };
			const error = new AuthApiError(422, "validation_error", "Invalid email", details);
			expect(error.status).toBe(422);
			expect(error.code).toBe("validation_error");
			expect(error.details).toEqual(details);
		});

		it("sets name to AuthApiError", () => {
			const error = new AuthApiError(401, "unauthorized", "Invalid credentials");
			expect(error.name).toBe("AuthApiError");
		});
	});
});
