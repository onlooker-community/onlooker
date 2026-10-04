import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROUTES, resolveRoute } from "./router";
import { BASE } from "./test-support/lessons.js";

/**
 * The routes that answer without any credential. This list is the point: an
 * unauthenticated endpoint becomes an edit somebody reviews, rather than a
 * function call somebody forgot.
 */
const EXPECTED_UNAUTHENTICATED = [
	"POST /auth/signup",
	"POST /auth/login",
	"POST /auth/refresh",
	"POST /auth/logout",
	"POST /auth/forgot-password",
	"GET /auth/reset-password/verify",
	"POST /auth/reset-password",
	"POST /auth/verify-email",
	"POST /api/client-errors",
	// Deliberately unauthenticated: a public lesson is meant to be readable by
	// anybody with the link, like a public gist. Adding to this list is meant
	// to be a reviewed decision, not an oversight.
	"GET /api/public/lessons/:id",
	// Deliberately unauthenticated, the same as /auth/reset-password/verify
	// above: the credential is the invitation token in the query string, not a
	// session. It only ever confirms or denies a token the caller already
	// holds.
	"GET /api/orgs/invites/verify",
];

/**
 * The routes any origin may read. Kept separate from auth deliberately: login
 * and signup are also unauthenticated and must stay locked to one origin,
 * because a hostile page reading their responses is what made credential
 * stuffing from arbitrary origins cheap.
 *
 * The one entry here is deliberately readable from any origin, not just
 * deliberately unauthenticated: a public lesson is meant to work like a public
 * gist, so a page on any domain must be able to fetch and render it. Adding to
 * this list is meant to be a reviewed decision, not an oversight.
 */
const EXPECTED_ANY_ORIGIN = ["GET /api/public/lessons/:id"];

const label = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("route table declarations", () => {
	it("only the expected routes are unauthenticated", () => {
		const actual = ROUTES.filter((r) => r.auth === "none")
			.map(label)
			.sort();
		expect(actual).toEqual([...EXPECTED_UNAUTHENTICATED].sort());
	});

	it("only the expected routes are readable from any origin", () => {
		const actual = ROUTES.filter((r) => r.cors === "any")
			.map(label)
			.sort();
		expect(actual).toEqual([...EXPECTED_ANY_ORIGIN].sort());
	});

	it("no credential-taking route is readable from any origin", () => {
		const both = ROUTES.filter((r) => r.cors === "any" && r.auth !== "none");
		expect(both.map(label)).toEqual([]);
	});
});

describe("GET / route listing", () => {
	// An operator route answers 404 to a signed-in non-operator specifically
	// so a prober cannot tell it apart from a path that does not exist -
	// middleware/principal.ts calls this out explicitly. GET / used to bypass
	// that entirely: it lists routes from a point before dispatch() ever runs,
	// with no credential check of its own, so it could confirm the operator
	// routes' existence for free. Asserted on the path shape rather than an
	// exact count or list, so this does not go stale every time a route -
	// operator or otherwise - is added.
	it("does not advertise any operator route", async () => {
		const response = await SELF.fetch(`${BASE}/`);
		const body = (await response.json()) as {
			endpoints: Array<{ method: string; path: string }>;
		};

		const adminPaths = body.endpoints.filter((endpoint) =>
			endpoint.path.includes("/api/admin/"),
		);

		expect(adminPaths).toEqual([]);
	});
});

describe("resolveRoute", () => {
	it("reaches the parameterized handler for a concrete id", () => {
		const paramHandler = async () => new Response(null);
		const routes = [
			{
				method: "DELETE" as const,
				path: "/things/:id",
				auth: "none" as const,
				cors: "app" as const,
				handler: paramHandler,
			},
		];

		const route = resolveRoute(routes, "DELETE", "/things/abc");
		expect(route?.route.handler).toBe(paramHandler);
	});

	it("does not let a parameter swallow an extra segment", () => {
		const paramHandler = async () => new Response(null);
		const routes = [
			{
				method: "DELETE" as const,
				path: "/things/:id",
				auth: "none" as const,
				cors: "app" as const,
				handler: paramHandler,
			},
		];

		expect(resolveRoute(routes, "DELETE", "/things/a/b")).toBeUndefined();
	});

	it("prefers an exact route over a parameterized route of the same shape", () => {
		// Two distinct functions - a mutation that mixed them up must be able to
		// tell them apart, so this cannot reuse a single shared no-op here.
		const exactHandler = async () => new Response("exact");
		const paramHandler = async () => new Response("param");
		const routes = [
			{
				method: "GET" as const,
				path: "/things/:id",
				auth: "none" as const,
				cors: "app" as const,
				handler: paramHandler,
			},
			{
				method: "GET" as const,
				path: "/things/mine",
				auth: "none" as const,
				cors: "app" as const,
				handler: exactHandler,
			},
		];

		const route = resolveRoute(routes, "GET", "/things/mine");
		expect(route?.route.handler).toBe(exactHandler);
	});

	it("returns the segment the parameter matched, keyed by its name", () => {
		const routes = [
			{
				method: "DELETE" as const,
				path: "/things/:id",
				auth: "none" as const,
				cors: "app" as const,
				handler: async () => new Response(null),
			},
		];

		expect(resolveRoute(routes, "DELETE", "/things/abc")?.params).toEqual({
			id: "abc",
		});
	});

	// The case the old idiom got wrong. Handlers used to re-derive the parameter
	// positionally, and the two live routes needed different rules to do it:
	// last segment for /machines/:id, second-to-last for /lessons/:id/status.
	// Pick the wrong rule and you read "status" as the id, which is a lookup miss
	// - a 404 or a no-op update, never an error that names the cause.
	it("captures a parameter that is not the last segment", () => {
		const routes = [
			{
				method: "POST" as const,
				path: "/things/:id/status",
				auth: "none" as const,
				cors: "app" as const,
				handler: async () => new Response(null),
			},
		];

		const matched = resolveRoute(routes, "POST", "/things/abc/status");
		expect(matched?.params).toEqual({ id: "abc" });
		expect(matched?.params.id).not.toBe("status");
	});

	it("captures every parameter when a pattern has more than one", () => {
		const routes = [
			{
				method: "GET" as const,
				path: "/users/:userId/things/:id",
				auth: "none" as const,
				cors: "app" as const,
				handler: async () => new Response(null),
			},
		];

		expect(
			resolveRoute(routes, "GET", "/users/u-1/things/t-2")?.params,
		).toEqual({ userId: "u-1", id: "t-2" });
	});

	// A fixed route has nothing to capture, and its handlers must not be handed
	// a key they would then read as real.
	it("gives an exact match no parameters", () => {
		const routes = [
			{
				method: "GET" as const,
				path: "/things",
				auth: "none" as const,
				cors: "app" as const,
				handler: async () => new Response(null),
			},
		];

		expect(resolveRoute(routes, "GET", "/things")?.params).toEqual({});
	});

	it("does not match a different literal segment in a parameterized pattern", () => {
		const routes = [
			{
				method: "POST" as const,
				path: "/things/:id/status",
				auth: "none" as const,
				cors: "app" as const,
				handler: async () => new Response(null),
			},
		];

		expect(resolveRoute(routes, "POST", "/things/abc/name")).toBeUndefined();
	});
});
