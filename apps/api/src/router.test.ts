import { describe, expect, it } from "vitest";
import { resolveRoute } from "./router";

describe("resolveRoute", () => {
	it("reaches the parameterized handler for a concrete id", () => {
		const paramHandler = async () => new Response(null);
		const routes = [
			{ method: "DELETE" as const, path: "/things/:id", handler: paramHandler },
		];

		const route = resolveRoute(routes, "DELETE", "/things/abc");
		expect(route?.handler).toBe(paramHandler);
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
		expect(route?.handler).toBe(exactHandler);
	});
});
