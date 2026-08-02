import type { AuthResponse, AuthSession } from "@onlooker/auth-react";
import {
	createAuthApiClient,
	createLocalStorageTokenStorage,
	createReactAuth,
} from "@onlooker/auth-react";
import { createMockFetch } from "./api/mockApi";

export interface User {
	id: string;
	email: string;
	name?: string;
}

export type AppAuthState = {};

const tokenStorage =
	typeof window !== "undefined"
		? createLocalStorageTokenStorage("auth_token")
		: { getToken: () => null, setToken: () => {}, clearToken: () => {} };

const mockFetch = createMockFetch();

const apiClient = createAuthApiClient({
	baseUrl: "",
	tokenStorage,
	fetchImpl: mockFetch as typeof fetch,
});

export const auth = createReactAuth<User, AppAuthState>({
	tokenStorage,
	initialState: {},
	loadSession: async (): Promise<AuthSession<User, AppAuthState>> => {
		try {
			const response = await apiClient.get<{ user: User }>("/auth/me");
			return { user: response.user };
		} catch {
			return { user: null as any };
		}
	},
	login: async (
		email: string,
		password: string,
	): Promise<AuthResponse<User>> => {
		return apiClient.post<AuthResponse<User>>("/auth/login", {
			email,
			password,
		});
	},
	signup: async (
		email: string,
		password: string,
		name?: string,
	): Promise<AuthResponse<User>> => {
		return apiClient.post<AuthResponse<User>>("/auth/signup", {
			email,
			password,
			name,
		});
	},
	logout: async () => {
		await apiClient.post("/auth/logout", {});
	},
});
