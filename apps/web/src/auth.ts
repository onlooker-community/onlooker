import { createReactAuth, createLocalStorageTokenStorage } from "@onlooker/auth-react";
import type { AuthResponse, AuthSession } from "@onlooker/auth-react";

export interface User {
	id: string;
	email: string;
	name?: string;
}

export interface AppAuthState {
	// Empty for Phase 2—can add extra state (permissions, roles) in Phase 3+
}

const tokenStorage = typeof window !== "undefined"
	? createLocalStorageTokenStorage("auth_token")
	: { getToken: () => null, setToken: () => {}, clearToken: () => {} };

export const auth = createReactAuth<User, AppAuthState>({
	tokenStorage,
	initialState: {},
	loadSession: async (): Promise<AuthSession<User, AppAuthState>> => {
		// Mock: will be implemented with real API in Task 6
		return { user: null as any };
	},
	login: async (_email: string, _password: string): Promise<AuthResponse<User>> => {
		// Mock: will be implemented with real API in Task 6
		throw new Error("Not implemented");
	},
	signup: async (_email: string, _password: string, _name?: string): Promise<AuthResponse<User>> => {
		// Mock: will be implemented with real API in Task 6
		throw new Error("Not implemented");
	},
	logout: async () => {
		// Mock: will be implemented with real API in Task 6
	},
});
