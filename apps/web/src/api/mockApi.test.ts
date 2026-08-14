// biome-ignore lint/suspicious/noExplicitAny: test code intentionally uses any
import { describe, expect, it } from "vitest";
import { createMockFetch, mockAuthApi } from "./mockApi";

describe("mockAuthApi", () => {
	it("returns token and user on valid login", async () => {
		const response = await mockAuthApi("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.token).toBeDefined();
		expect(data.user.email).toBe("test@example.com");
	});

	it("returns 401 on invalid credentials", async () => {
		try {
			await mockAuthApi("/auth/login", {
				method: "POST",
				body: JSON.stringify({ email: "test@example.com", password: "wrong" }),
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.status).toBe(401);
		}
	});

	it("creates user on signup", async () => {
		const response = await mockAuthApi("/auth/signup", {
			method: "POST",
			body: JSON.stringify({
				email: "newuser@example.com",
				password: "password123",
				name: "New User",
			}),
		});

		// 201, matching apps/api. This asserted 200 and passed for as long as it
		// existed, because it only ever described the mock to itself.
		expect(response.status).toBe(201);
		const data = (await response.json()) as any;
		expect(data.user.email).toBe("newuser@example.com");
	});

	it("returns 409 if user already exists on signup", async () => {
		try {
			await mockAuthApi("/auth/signup", {
				method: "POST",
				body: JSON.stringify({
					email: "test@example.com",
					password: "password123",
					name: "Test",
				}),
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.status).toBe(409);
		}
	});

	it("verifies token on /auth/me", async () => {
		// First get a token from login
		const loginResponse = await mockAuthApi("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		const loginData = (await loginResponse.json()) as any;
		const token = loginData.token;

		// Now use it to get user info
		const meResponse = await mockAuthApi("/auth/me", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(meResponse.status).toBe(200);
		const meData = (await meResponse.json()) as any;
		expect(meData.user.email).toBe("test@example.com");
	});

	it("returns 401 with invalid token on /auth/me", async () => {
		try {
			await mockAuthApi("/auth/me", {
				method: "GET",
				headers: { Authorization: "Bearer invalid-token" },
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.status).toBe(401);
		}
	});

	it("handles logout", async () => {
		const response = await mockAuthApi("/auth/logout", {
			method: "POST",
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.success).toBe(true);
	});

	it("createMockFetch intercepts /auth/* paths only", async () => {
		const mockFetch = createMockFetch();

		// This should be intercepted
		const authResponse = await mockFetch("/auth/login", {
			method: "POST",
			body: JSON.stringify({
				email: "test@example.com",
				password: "password123",
			}),
		});
		expect(authResponse.status).toBe(200);
	});
});
