// ============================================================================
// JWT parsing (client-side, no verification)
// ============================================================================
//
// These helpers decode the *payload* of a JWT to read claims like `exp`. They
// intentionally do NOT verify the signature — the server is the only authority
// on token validity. Client-side we only use `exp` to schedule proactive
// refreshes and expiry warnings, so a tampered token at worst causes an early
// refresh, never an authorization decision.
//
// Opaque (non-JWT) tokens are handled gracefully: every function returns
// null/false rather than throwing, so a mock or opaque bearer token simply has
// "unknown" expiry and is left to the server to validate.

function base64UrlDecode(input: string): string | null {
	let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const remainder = base64.length % 4;
	if (remainder === 1) return null; // not a valid base64url length
	if (remainder === 2) base64 += "==";
	else if (remainder === 3) base64 += "=";

	try {
		if (typeof atob === "function") {
			const binary = atob(base64);
			if (typeof TextDecoder !== "undefined") {
				const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
				return new TextDecoder().decode(bytes);
			}
			return binary;
		}
		// Node fallback when atob is unavailable.
		const nodeBuffer = (globalThis as { Buffer?: typeof globalThis.Buffer })
			.Buffer;
		if (nodeBuffer) {
			return nodeBuffer.from(base64, "base64").toString("utf-8");
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Decode a JWT's payload segment to a plain object. Returns null for anything
 * that is not a well-formed three-segment JWT with a JSON object payload
 * (including opaque/mock tokens).
 */
export function decodeJwtPayload(
	token: string,
): Record<string, unknown> | null {
	if (typeof token !== "string" || token.length === 0) return null;

	const segments = token.split(".");
	if (segments.length !== 3) return null;

	const json = base64UrlDecode(segments[1]);
	if (json === null) return null;

	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Expiration time of a JWT in **milliseconds** since the epoch, or null when
 * the token has no numeric `exp` claim (opaque token, or a JWT that omits exp).
 */
export function getTokenExpiration(token: string): number | null {
	const payload = decodeJwtPayload(token);
	if (!payload) return null;

	const exp = payload.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

	return exp * 1000;
}

/**
 * Whether a token is expired at `nowMs`. Tokens with unknown expiry are treated
 * as NOT expired here — we let the server reject them rather than logging the
 * user out over a token we simply can't read.
 */
export function isTokenExpired(
	token: string,
	nowMs: number = Date.now(),
): boolean {
	const expiresAt = getTokenExpiration(token);
	if (expiresAt === null) return false;
	return nowMs >= expiresAt;
}
