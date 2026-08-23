import { describe, expect, it } from "vitest";
import { resolveRoute } from "./router";

describe("resolveRoute", () => {
	it("reaches the parameterized handler for a concrete id", () => {
		const paramHandler = async () => new Response(null);
		const routes = [
			{ method: "DELETE" as const, path: "/things/:id", handler: paramHandler },
		];

		const route = resolveRoute(routes, "DELETE", "/things/abc");
		expect(route?.route.handler).toBe(paramHandler);
	});

	it("does not let a parameter swallow an extra segment", () => {
		const paramHandler = async () => new Response(null);
		const routes = [
			{ method: "DELETE" as const, path: "/things/:id", handler: paramHandler },
		];

		expect(resolveRoute(routes, "DELETE", "/things/a/b")).toBeUndefined();
	});

	it("prefers an exact route over a parameterized route of the same shape", () => {
		// Two distinct functions - a mutation that mixed them up must be able to
		// tell them apart, so this cannot reuse a single shared no-op here.
		const exactHandler = async () => new Response("exact");
		const paramHandler = async () => new Response("param");
		const routes = [
			{ method: "GET" as const, path: "/things/:id", handler: paramHandler },
			{ method: "GET" as const, path: "/things/mine", handler: exactHandler },
		];

		const route = resolveRoute(routes, "GET", "/things/mine");
		expect(route?.route.handler).toBe(exactHandler);
	});

	it("returns the segment the parameter matched, keyed by its name", () => {
		const routes = [
			{
				method: "DELETE" as const,
				path: "/things/:id",
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
				handler: async () => new Response(null),
			},
		];

		expect(resolveRoute(routes, "POST", "/things/abc/name")).toBeUndefined();
	});
});
