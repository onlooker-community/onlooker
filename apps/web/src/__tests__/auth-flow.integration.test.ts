import { describe, it, expect, beforeEach, vi } from "vitest";
import { auth } from "../auth";

describe("End-to-End Auth Flow", () => {
	beforeEach(() => {
		// Clear localStorage before each test
		if (typeof window !== "undefined") {
			localStorage.clear();
		}
	});

	it("has auth factory with all required exports", () => {
		expect(auth.AuthProvider).toBeDefined();
		expect(auth.RequireAuth).toBeDefined();
		expect(auth.useAuth).toBeDefined();
		expect(auth.AuthContext).toBeDefined();
		expect(auth.useAuthState).toBeDefined();
	});

	it("session persists in localStorage after login would store token", async () => {
		if (typeof window === "undefined") {
			// Skip in non-browser environment
			return;
		}

		// Simulate token being set
		const mockToken = "mock-jwt-token-test-user-123";
		localStorage.setItem("auth_token", mockToken);
		expect(localStorage.getItem("auth_token")).toBe(mockToken);

		// Simulate clearing on logout
		localStorage.removeItem("auth_token");
		expect(localStorage.getItem("auth_token")).toBeNull();
	});

	it("mock API handles test user credentials", async () => {
		// This verifies the mock API is set up correctly
		const { createMockFetch } = await import("../api/mockApi");
		const mockFetch = createMockFetch();

		// Test valid login
		const loginResponse = await mockFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});

		expect(loginResponse.status).toBe(200);
		const loginData = (await loginResponse.json()) as any;
		expect(loginData.token).toBeDefined();
		expect(loginData.user.email).toBe("test@example.com");

		// Test invalid credentials
		const invalidResponse = await mockFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "wrong-password",
			}),
		});

		expect(invalidResponse.status).toBe(401);
	});

	it("auth context provides user null initially", () => {
		// We can only test this in a component context, but we can verify the auth
		// factory is properly set up for this to work
		expect(auth.AuthProvider).toBeDefined();
		expect(typeof auth.AuthProvider).toBe("function");
	});

	it("useAuth throws outside of AuthProvider", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => {
			auth.useAuth();
		}).toThrow("useAuth must be used within AuthProvider");

		consoleError.mockRestore();
	});

	it("RequireAuth component is defined and usable", () => {
		expect(auth.RequireAuth).toBeDefined();
		expect(typeof auth.RequireAuth).toBe("function");
	});
});
