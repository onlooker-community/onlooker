/**
 * API endpoint contract and request/response types.
 *
 * ## Endpoint reference
 *
 * | Name    | Method | Path            | Auth header | Body                              | Response                          |
 * | ------- | ------ | --------------- | ----------- | --------------------------------- | --------------------------------- |
 * | login   | POST   | `/auth/login`   | no          | `LoginRequest`                    | `AuthTokenResponse`               |
 * | signup  | POST   | `/auth/signup`  | no          | `SignupRequest`                   | `AuthTokenResponse`               |
 * | refresh | POST   | `/auth/refresh` | no          | `RefreshRequest`                  | `RefreshResponse`                 |
 * | me      | GET    | `/auth/me`      | yes         | —                                 | `MeResponse`                      |
 * | logout  | POST   | `/auth/logout`  | yes         | —                                 | `LogoutResponse`                  |
 *
 * ## Resource endpoints (authenticated)
 *
 * | Name      | Method | Path               | Auth header | Body | Response                        |
 * | --------- | ------ | ------------------ | ----------- | ---- | ------------------------------- |
 * | me        | GET    | `/api/users/me`    | yes         | —    | `UserProfile` (`../types/api`)  |
 *
 * These ride the same authenticated transport (auth header, refresh-on-401,
 * retry). They are NOT in `REFRESH_EXEMPT_PATHS`, so a 401 triggers a refresh
 * and replay like any other protected call. The real API must implement them to
 * match the `UserProfile` shape.
 *
 * ## Token lifecycle
 *
 * 1. `login`/`signup` return a short-lived `token` (access) plus a long-lived
 *    `refreshToken`. The access token is sent as `Authorization: Bearer <token>`.
 * 2. When a protected request returns `401`, the client posts the stored
 *    refresh token to `/auth/refresh` to obtain a new access token (and a
 *    rotated refresh token), then retries the original request once.
 * 3. `logout` invalidates the session server-side; the client also clears both
 *    tokens from storage.
 */

import type { AuthResponse } from "@onlooker/auth-react";
import type { User } from "../auth";

export const AUTH_ENDPOINTS = {
	login: "/auth/login",
	signup: "/auth/signup",
	refresh: "/auth/refresh",
	me: "/auth/me",
	logout: "/auth/logout",
} as const;

/** Endpoint paths that must never trigger the automatic-refresh middleware. */
export const REFRESH_EXEMPT_PATHS: readonly string[] = [
	AUTH_ENDPOINTS.login,
	AUTH_ENDPOINTS.signup,
	AUTH_ENDPOINTS.refresh,
];

export interface LoginRequest {
	email: string;
	password: string;
}

export interface SignupRequest {
	email: string;
	password: string;
	name?: string;
}

export interface RefreshRequest {
	refreshToken: string;
}

/** Login/signup response: access token, rotating refresh token, and the user. */
export type AuthTokenResponse = AuthResponse<User> & {
	refreshToken: string;
};

export interface RefreshResponse {
	token: string;
	refreshToken: string;
}

export interface MeResponse {
	user: User;
}

export interface LogoutResponse {
	success: boolean;
}

/** The two tokens that make up an authenticated session. */
export interface AuthTokens {
	accessToken: string | null;
	refreshToken: string | null;
}

/** Normalized error body returned by the API on non-2xx responses. */
export interface ApiErrorBody {
	error: string;
	message?: string;
	details?: unknown;
}
