import { AuthApiError, type AuthResponse } from "@onlooker/auth-react";
import type { User } from "../auth";

const MOCK_USERS: Record<
	string,
	{ id: string; email: string; name: string; password: string }
> = {
	"test@example.com": {
		id: "user-1",
		email: "test@example.com",
		name: "Test User",
		password: "password123",
	},
};

const MOCK_TOKENS: Record<string, string> = {
	"test@example.com": "mock-jwt-token-test-user-123",
};

export async function mockAuthApi(
	path: string,
	options: RequestInit,
): Promise<Response> {
	// Intercept auth endpoints and return mock responses
	if (path === "/auth/login" && options.method === "POST") {
		const body = JSON.parse(options.body as string);
		const { email, password } = body;

		const user = MOCK_USERS[email];
		if (!user || user.password !== password) {
			throw new AuthApiError(
				401,
				"invalid_credentials",
				"Email or password incorrect",
			);
		}

		const response: AuthResponse<User> = {
			token: MOCK_TOKENS[email],
			user: { id: user.id, email: user.email, name: user.name },
		};

		return new Response(JSON.stringify(response), { status: 200 });
	}

	if (path === "/auth/signup" && options.method === "POST") {
		const body = JSON.parse(options.body as string);
		const { email, password, name } = body;

		if (MOCK_USERS[email]) {
			throw new AuthApiError(409, "user_exists", "User already exists");
		}

		// Create new user
		const newUser = {
			id: `user-${Date.now()}`,
			email,
			name: name || "Anonymous",
			password,
		};
		MOCK_USERS[email] = newUser;
		MOCK_TOKENS[email] = `mock-jwt-token-${newUser.id}`;

		const response: AuthResponse<User> = {
			token: MOCK_TOKENS[email],
			user: { id: newUser.id, email: newUser.email, name: newUser.name },
		};

		return new Response(JSON.stringify(response), { status: 200 });
	}

	if (path === "/auth/me" && options.method === "GET") {
		const authHeader =
			options.headers && typeof options.headers === "object"
				? (options.headers as Record<string, string>)
				: {};
		const token = authHeader["Authorization"]?.replace("Bearer ", "");
		const user = Object.entries(MOCK_TOKENS).find(([_, t]) => t === token)?.[0];

		if (!user || !MOCK_USERS[user]) {
			throw new AuthApiError(401, "unauthorized", "Invalid token");
		}

		const mockUser = MOCK_USERS[user];
		return new Response(
			JSON.stringify({
				user: { id: mockUser.id, email: mockUser.email, name: mockUser.name },
			}),
			{ status: 200 },
		);
	}

	if (path === "/auth/logout" && options.method === "POST") {
		return new Response(JSON.stringify({ success: true }), { status: 200 });
	}

	// If no mock route matches, return 404
	throw new AuthApiError(404, "not_found", `Mock endpoint not found: ${path}`);
}

export function createMockFetch() {
	return async (url: string, options: RequestInit = {}) => {
		// Only intercept /auth/* paths
		if (url.includes("/auth/")) {
			try {
				return await mockAuthApi(url, options);
			} catch (error) {
				if (error instanceof AuthApiError) {
					return new Response(
						JSON.stringify({
							error: error.code,
							message: error.message,
							details: error.details,
						}),
						{ status: error.status },
					);
				}
				throw error;
			}
		}

		// For non-auth paths, use real fetch
		return fetch(url, options);
	};
}
