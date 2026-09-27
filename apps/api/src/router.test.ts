import { describe, expect, it } from "vitest";
import { ROUTES, resolveRoute } from "./router";

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
	// Task 5 adds "GET /api/public/lessons/:id" here when the route exists.
	// Listing it before then would commit a red test, and every commit on this
	// branch is green.
];

/**
 * The routes any origin may read. Kept separate from auth deliberately: login
 * and signup are also unauthenticated and must stay locked to one origin,
 * because a hostile page reading their responses is what made credential
 * stuffing from arbitrary origins cheap.
 *
 * Empty until Task 5. That is the correct expectation right now: no route today
 * should answer an arbitrary origin.
 */
const EXPECTED_ANY_ORIGIN: string[] = [];

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
