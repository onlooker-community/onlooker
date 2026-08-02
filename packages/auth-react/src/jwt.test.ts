import { describe, expect, it } from "vitest";
import { decodeJwtPayload, getTokenExpiration, isTokenExpired } from "./jwt";

// Minimal base64url JWT encoder for building fixtures (payload only; the header
// and signature are placeholders — client-side code never verifies them).
function encodeJwt(payload: Record<string, unknown>): string {
	const b64url = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj))
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("decodeJwtPayload", () => {
	it("decodes a well-formed JWT payload", () => {
		const token = encodeJwt({
			sub: "user-1",
			kind: "user",
			exp: 1_700_000_000,
		});
		expect(decodeJwtPayload(token)).toEqual({
			sub: "user-1",
			kind: "user",
			exp: 1_700_000_000,
		});
	});

	it("decodes payloads containing multi-byte UTF-8", () => {
		const token = encodeJwt({ sub: "user-1", name: "Ünîçodé 🚀" });
		expect(decodeJwtPayload(token)).toMatchObject({ name: "Ünîçodé 🚀" });
	});

	it("returns null for opaque (non-JWT) tokens", () => {
		expect(decodeJwtPayload("mock-access-test@example.com-1")).toBeNull();
	});

	it("returns null for wrong segment counts", () => {
		expect(decodeJwtPayload("a.b")).toBeNull();
		expect(decodeJwtPayload("a.b.c.d")).toBeNull();
	});

	it("returns null for a payload that is not JSON", () => {
		const bad = `${Buffer.from("header").toString("base64url")}.${Buffer.from(
			"not-json",
		).toString("base64url")}.sig`;
		expect(decodeJwtPayload(bad)).toBeNull();
	});

	it("returns null for a JSON array payload (not an object)", () => {
		const arr = `h.${Buffer.from("[1,2,3]").toString("base64url")}.sig`;
		expect(decodeJwtPayload(arr)).toBeNull();
	});

	it("returns null for empty / non-string input", () => {
		expect(decodeJwtPayload("")).toBeNull();
		// @ts-expect-error exercising runtime guard
		expect(decodeJwtPayload(undefined)).toBeNull();
	});
});

describe("getTokenExpiration", () => {
	it("returns exp in milliseconds", () => {
		const token = encodeJwt({ sub: "user-1", exp: 1_700_000_000 });
		expect(getTokenExpiration(token)).toBe(1_700_000_000_000);
	});

	it("returns null when exp is missing", () => {
		expect(getTokenExpiration(encodeJwt({ sub: "user-1" }))).toBeNull();
	});

	it("returns null when exp is not a finite number", () => {
		expect(getTokenExpiration(encodeJwt({ exp: "soon" }))).toBeNull();
		expect(getTokenExpiration(encodeJwt({ exp: null }))).toBeNull();
	});

	it("returns null for opaque tokens", () => {
		expect(getTokenExpiration("mock-access-abc")).toBeNull();
	});
});

describe("isTokenExpired", () => {
	const now = 1_700_000_000_000;

	it("is true once past exp", () => {
		const token = encodeJwt({ exp: 1_700_000_000 }); // == now (ms)
		expect(isTokenExpired(token, now)).toBe(true);
		expect(isTokenExpired(token, now + 1)).toBe(true);
	});

	it("is false before exp", () => {
		const token = encodeJwt({ exp: 1_700_000_060 }); // now + 60s
		expect(isTokenExpired(token, now)).toBe(false);
	});

	it("treats unknown-expiry (opaque) tokens as NOT expired", () => {
		expect(isTokenExpired("mock-access-abc", now)).toBe(false);
	});
});
