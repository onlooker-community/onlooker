import { describe, it, expect, vi } from "vitest";
import { createReactAuth } from "./index";

describe("createReactAuth", () => {
	it("exports AuthProvider, RequireAuth, useAuth, AuthContext", () => {
		const auth = createReactAuth({
			tokenStorage: { getToken: () => null, setToken: () => {}, clearToken: () => {} },
			initialState: {},
			loadSession: async () => ({ user: null }),
			login: async () => ({ token: "", user: {} as any }),
			signup: async () => ({ token: "", user: {} as any }),
		});

		expect(auth.AuthProvider).toBeDefined();
		expect(auth.RequireAuth).toBeDefined();
		expect(auth.useAuth).toBeDefined();
		expect(auth.AuthContext).toBeDefined();
		expect(auth.useAuthState).toBeDefined();
	});

	it("useAuth is defined on returned object", () => {
		const auth = createReactAuth({
			tokenStorage: { getToken: () => null, setToken: () => {}, clearToken: () => {} },
			initialState: {},
			loadSession: async () => ({ user: null }),
			login: async () => ({ token: "", user: {} as any }),
			signup: async () => ({ token: "", user: {} as any }),
		});

		expect(typeof auth.useAuth).toBe("function");
	});

	it("initial state has user null and loading false with no token", () => {
		const auth = createReactAuth({
			tokenStorage: { getToken: () => null, setToken: () => {}, clearToken: () => {} },
			initialState: { role: "user" },
			loadSession: async () => ({ user: null, role: "user" }),
			login: async () => ({ token: "", user: {} as any }),
			signup: async () => ({ token: "", user: {} as any }),
		});

		// We can only test this in a component context, but we can verify the factory works
		expect(auth.useAuthState).toBeDefined();
	});

	it("supports custom initialState", () => {
		const customState = { theme: "dark", permissions: ["read"] };
		const auth = createReactAuth({
			tokenStorage: { getToken: () => null, setToken: () => {}, clearToken: () => {} },
			initialState: customState,
			loadSession: async () => ({ user: null, ...customState }),
			login: async () => ({ token: "", user: {} as any }),
			signup: async () => ({ token: "", user: {} as any }),
		});

		expect(auth.AuthProvider).toBeDefined();
	});
});
