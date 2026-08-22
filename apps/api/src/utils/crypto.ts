import * as bcrypt from "bcryptjs";
import * as jose from "jose";

export interface JwtPayload {
	sub: string; // user ID
	email: string;
	type: "access" | "refresh"; // token type
	iat: number;
	exp: number;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = await bcrypt.genSalt(10);
	return bcrypt.hash(password, salt);
}

/**
 * Verify a password against a bcrypt hash
 */
export async function verifyPassword(
	password: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

/**
 * Sign a JWT token
 */
export async function signJwt(
	payload: Omit<JwtPayload, "iat" | "exp">,
	secret: string,
	expiresInMinutes: number,
): Promise<string> {
	const secretBuffer = new TextEncoder().encode(secret);
	return new jose.SignJWT(payload)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(`${expiresInMinutes}m`)
		.sign(secretBuffer);
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJwt(
	token: string,
	secret: string,
): Promise<JwtPayload | null> {
	try {
		const secretBuffer = new TextEncoder().encode(secret);
		const verified = await jose.jwtVerify(token, secretBuffer);
		return verified.payload as unknown as JwtPayload;
	} catch {
		return null;
	}
}

/**
 * Generate a random refresh token.
 *
 * 32 bytes from crypto.getRandomValues, hex encoded. This matches
 * createVerificationToken in db/queries.ts, deliberately - it was the only
 * correct precedent in the codebase when this was fixed.
 *
 * This used to build the token from Math.random() in a loop, which is not a
 * CSPRNG: V8 implements it as xorshift128+ with a per-isolate seed, and enough
 * observed outputs recover the internal state. Workers reuse isolates across
 * requests, so an attacker able to mint several tokens from one isolate had a
 * path at the others it produced. See onlooker-axo.
 */
export function generateRefreshToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 of a bearer token. Sessions, verification tokens, and machine
 * tokens all store only this - a read of any of those tables must not
 * produce a working credential.
 *
 * Not bcrypt, deliberately. These are 256 bits of crypto random, not a
 * password - there is no dictionary to slow an attacker down, so a work
 * factor buys nothing, and it would be paid on every request that presents
 * one (every sync request, for machine tokens).
 *
 * The one hash. Imported, never re-declared - two copies drift apart with no
 * symptom until one changes and the other doesn't, and tokens stop verifying
 * with nothing to point at.
 */
export async function hashToken(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
