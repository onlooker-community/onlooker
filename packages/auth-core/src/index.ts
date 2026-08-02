import { z } from "zod";

export const TOKEN_KIND_USER = "user";
export const TOKEN_KIND_MACHINE = "machine";

export type TokenKind = typeof TOKEN_KIND_USER | typeof TOKEN_KIND_MACHINE;

export interface BaseTokenClaims extends Record<string, unknown> {
	sub: string;
	kind: TokenKind;
	iat?: number;
	exp?: number;
}

export interface UserTokenClaims extends BaseTokenClaims {
	kind: typeof TOKEN_KIND_USER;
}

export interface MachineTokenClaims extends BaseTokenClaims {
	kind: typeof TOKEN_KIND_MACHINE;
	machine_id: string;
}

export type AuthTokenClaims = UserTokenClaims | MachineTokenClaims;

export const userTokenClaimsSchema = z
	.object({
		sub: z.string().min(1),
		kind: z.literal(TOKEN_KIND_USER),
	})
	.passthrough();

export const machineTokenClaimsSchema = z
	.object({
		sub: z.string().min(1),
		kind: z.literal(TOKEN_KIND_MACHINE),
		machine_id: z.string().min(1),
	})
	.passthrough();

export const authTokenClaimsSchema = z.discriminatedUnion("kind", [
	userTokenClaimsSchema,
	machineTokenClaimsSchema,
]);

export function isUserTokenClaims(
	claims: Record<string, unknown>,
): claims is UserTokenClaims {
	return claims.kind === TOKEN_KIND_USER;
}

export function isMachineTokenClaims(
	claims: Record<string, unknown>,
): claims is MachineTokenClaims {
	return (
		claims.kind === TOKEN_KIND_MACHINE && typeof claims.machine_id === "string"
	);
}

export function parseAuthTokenClaims(claims: unknown): AuthTokenClaims {
	return authTokenClaimsSchema.parse(claims);
}

export const signupInputSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8).max(128),
	name: z.string().min(1).max(128).optional(),
});

export const loginInputSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
});

export const changePasswordInputSchema = z.object({
	current_password: z.string().min(1),
	new_password: z.string().min(8).max(128),
});

export const machineLinkBodySchema = z.object({
	machine_id: z.string().uuid(),
});

export const machineLinkQuerySchema = z.object({
	machine_id: z.string().uuid(),
});

export const authErrorBodySchema = z.object({
	error: z.string(),
	message: z.string().optional(),
	details: z.unknown().optional(),
});

export type SignupInput = z.infer<typeof signupInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;
export type MachineLinkBody = z.infer<typeof machineLinkBodySchema>;
export type MachineLinkQuery = z.infer<typeof machineLinkQuerySchema>;
export type AuthErrorBody = z.infer<typeof authErrorBodySchema>;

export interface AuthResponse<TUser> {
	token: string;
	user: TUser;
}

export type AuthSession<
	TUser,
	TExtra extends object = Record<string, never>,
> = { user: TUser } & TExtra;

export class AuthApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;

	constructor(
		status: number,
		code: string,
		message: string,
		details?: unknown,
	) {
		super(message);
		this.name = "AuthApiError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}
