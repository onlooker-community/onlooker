import { env as bindings } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../types";
import { ApiError } from "../types";
import { signJwt } from "../utils/crypto";
import { optionalAuth, requireAuth } from "./auth";

/**
 * Both functions accept only an *access* token. A refresh token is signed
 * with the same secret and verifies just as well, so the `type` check is the
 * only thing stopping a long-lived refresh token from authenticating
 * requests. Nothing tested it before ONL-80 rewrote the condition.
 *
 * The signing key is the test worker's own JWT_SECRET binding, set in
 * vitest.config.ts. Test env.d.ts types only the bindings the D1 tests need,
 * hence the cast.
 */
const env = bindings as unknown as WorkerEnv;

const user = { sub: "user-1", email: "user@example.com" };

function request(token?: string): Request {
	return new Request("https://api.test/", {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
}

const access = () => signJwt({ ...user, type: "access" }, env.JWT_SECRET, 5);
const refresh = () => signJwt({ ...user, type: "refresh" }, env.JWT_SECRET, 5);

async function rejection(promise: Promise<unknown>) {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return { status: (error as ApiError).status, code: (error as ApiError).code };
}

describe("requireAuth", () => {
	it("accepts an access token", async () => {
		await expect(requireAuth(request(await access()), env)).resolves.toEqual({
			userId: user.sub,
			email: user.email,
		});
	});

	it("rejects a refresh token", async () => {
		expect(await rejection(requireAuth(request(await refresh()), env))).toEqual(
			{ status: 401, code: "invalid_token" },
		);
	});

	it("rejects a token that doesn't verify", async () => {
		expect(await rejection(requireAuth(request("not-a-jwt"), env))).toEqual({
			status: 401,
			code: "invalid_token",
		});
	});

	it("rejects a request with no token", async () => {
		expect(await rejection(requireAuth(request(), env))).toEqual({
			status: 401,
			code: "unauthorized",
		});
	});
});

describe("optionalAuth", () => {
	it("returns the user for an access token", async () => {
		await expect(optionalAuth(request(await access()), env)).resolves.toEqual({
			userId: user.sub,
			email: user.email,
		});
	});

	it("returns null for a refresh token", async () => {
		await expect(
			optionalAuth(request(await refresh()), env),
		).resolves.toBeNull();
	});

	it("returns null for a token that doesn't verify", async () => {
		await expect(optionalAuth(request("not-a-jwt"), env)).resolves.toBeNull();
	});

	it("returns null with no token", async () => {
		await expect(optionalAuth(request(), env)).resolves.toBeNull();
	});
});
