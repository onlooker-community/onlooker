import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../types";
import { preflightResponse, withCors } from "./cors";

// The worker answered every request with Access-Control-Allow-Origin: *, while
// wrangler.toml declared a CORS_ORIGIN per environment that nothing read. So the
// config described a policy - production restricted to app.onlooker.dev - that
// was not enforced anywhere, and anyone reading it would have believed it.
//
// The exposure was narrower than the header looked, because this API
// authenticates with Bearer tokens from localStorage rather than cookies: a
// hostile page cannot read a victim's token cross-origin, so it could not forge
// authenticated calls. What it could do is call the unauthenticated endpoints
// from anywhere and read the answers - login and signup among them - which made
// credential stuffing from arbitrary origins cheaper than it should be.

function env(corsOrigin?: string): WorkerEnv {
	return { CORS_ORIGIN: corsOrigin } as WorkerEnv;
}

function request(origin?: string, method = "GET"): Request {
	return new Request("https://api.onlooker.dev/auth/me", {
		method,
		headers: origin ? { Origin: origin } : {},
	});
}

const PRODUCTION = "https://app.onlooker.dev";

describe("withCors", () => {
	it("echoes an allowed origin instead of opening up to everyone", () => {
		const res = withCors(
			new Response("ok"),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PRODUCTION);
	});

	it("never answers with a wildcard", () => {
		const res = withCors(
			new Response("ok"),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
	});

	it("sends no allow-origin at all to an origin that is not on the list", () => {
		const res = withCors(
			new Response("ok"),
			request("https://evil.example"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	// Substring and prefix matching are the classic way an allowlist leaks:
	// app.onlooker.dev.evil.example contains the allowed origin, and an attacker
	// controls the whole suffix.
	it("does not match an origin that merely contains an allowed one", () => {
		const res = withCors(
			new Response("ok"),
			request("https://app.onlooker.dev.evil.example"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("treats a different scheme as a different origin", () => {
		const res = withCors(
			new Response("ok"),
			request("http://app.onlooker.dev"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	// curl, the heartbeat, and anything server-to-server. CORS is a browser
	// mechanism, so these are unaffected either way - but there is no origin to
	// answer, and inventing one would be noise.
	it("sends no CORS headers when the request carries no Origin", () => {
		const res = withCors(new Response("ok"), request(), env(PRODUCTION));

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	// The answer now depends on who asked. Without this, a shared cache can hand
	// one site's allowed response to another site - or cache the absent header
	// and lock out the real front end.
	it("varies on Origin, so a cache cannot serve one site's answer to another", () => {
		const res = withCors(
			new Response("ok"),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Vary")).toContain("Origin");
	});

	it("varies on Origin even when the origin is refused", () => {
		const res = withCors(
			new Response("ok"),
			request("https://evil.example"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Vary")).toContain("Origin");
	});

	it("allows any origin in a comma-separated list", () => {
		const both = `${PRODUCTION},https://onlooker.dev`;

		expect(
			withCors(new Response("ok"), request(PRODUCTION), env(both)).headers.get(
				"Access-Control-Allow-Origin",
			),
		).toBe(PRODUCTION);
		expect(
			withCors(
				new Response("ok"),
				request("https://onlooker.dev"),
				env(both),
			).headers.get("Access-Control-Allow-Origin"),
		).toBe("https://onlooker.dev");
	});

	it("tolerates whitespace around the separators", () => {
		const res = withCors(
			new Response("ok"),
			request(PRODUCTION),
			env(`  https://onlooker.dev ,  ${PRODUCTION}  `),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PRODUCTION);
	});

	// Fail closed. An unset CORS_ORIGIN is a misconfiguration, and the wrong way
	// to handle it is the way this code used to behave by default - allow
	// everyone, silently. A blocked front end is loud and fixable; a silently
	// open API is neither.
	it("allows nothing when CORS_ORIGIN is unset", () => {
		const res = withCors(new Response("ok"), request(PRODUCTION), env());

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("allows nothing when CORS_ORIGIN is empty", () => {
		const res = withCors(new Response("ok"), request(PRODUCTION), env("   "));

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	// Echoing an origin and allowing credentials is the combination that turns a
	// permissive allowlist into session theft. This API has no use for it - it
	// authenticates with Bearer tokens the browser attaches deliberately, not
	// cookies it attaches on its own - so the header should stay absent.
	it("does not enable credentials", () => {
		const res = withCors(
			new Response("ok"),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
	});

	it("leaves the response status and body alone", async () => {
		const res = withCors(
			new Response(JSON.stringify({ id: "u1" }), { status: 201 }),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ id: "u1" });
	});

	it("keeps headers the handler already set", () => {
		const res = withCors(
			new Response("{}", { headers: { "Content-Type": "application/json" } }),
			request(PRODUCTION),
			env(PRODUCTION),
		);

		expect(res.headers.get("Content-Type")).toBe("application/json");
	});
});

describe("preflightResponse", () => {
	it("tells an allowed origin what it may send", () => {
		const res = preflightResponse(
			request(PRODUCTION, "OPTIONS"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PRODUCTION);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
			"Authorization",
		);
		expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
	});

	// A refused preflight should not double as a description of the API. There is
	// nothing secret in the method list, but advertising it to an origin being
	// turned away is answering a question nobody is allowed to ask.
	it("tells a refused origin nothing", () => {
		const res = preflightResponse(
			request("https://evil.example", "OPTIONS"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
		expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
	});

	it("varies on Origin", () => {
		const res = preflightResponse(
			request(PRODUCTION, "OPTIONS"),
			env(PRODUCTION),
		);

		expect(res.headers.get("Vary")).toContain("Origin");
	});
});
