import { describe, expect, it } from "vitest";
import type { UserProfile } from "../types/api";
import { createMockFetch, mockAuthApi, mockDataApi } from "./mockApi";

async function loginToken(): Promise<string> {
	const response = await mockAuthApi("/auth/login", {
		method: "POST",
		body: JSON.stringify({
			email: "test@example.com",
			password: "password123",
		}),
	});
	const data = (await response.json()) as { token: string };
	return data.token;
}

function authGet(token: string): RequestInit {
	return { method: "GET", headers: { Authorization: `Bearer ${token}` } };
}

describe("mockDataApi", () => {
	it("returns the authenticated user's profile with account dates", async () => {
		const token = await loginToken();

		const response = await mockDataApi("/api/users/me", authGet(token));
		expect(response.status).toBe(200);

		const profile = (await response.json()) as UserProfile;
		expect(profile.email).toBe("test@example.com");
		expect(profile.name).toBe("Test User");
		expect(Number.isNaN(Date.parse(profile.createdAt))).toBe(false);
		expect(Number.isNaN(Date.parse(profile.lastLoginAt))).toBe(false);
	});

	it("rejects /api/users/me without a valid token", async () => {
		await expect(
			mockDataApi("/api/users/me", { method: "GET" }),
		).rejects.toMatchObject({ status: 401 });
	});

	it("routes /api/* through createMockFetch and returns 401 as a Response", async () => {
		const mockFetch = createMockFetch();

		const response = await mockFetch("/api/users/me", { method: "GET" });
		expect(response.status).toBe(401);
	});

	it("serves the profile through createMockFetch with a bearer token", async () => {
		const mockFetch = createMockFetch();
		const token = await loginToken();

		const response = await mockFetch("/api/users/me", authGet(token));
		expect(response.status).toBe(200);
		const profile = (await response.json()) as UserProfile;
		expect(profile.id).toBe("user-1");
	});
});
