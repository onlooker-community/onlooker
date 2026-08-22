import { describe, expect, it } from "vitest";
import { findRoute, pathMatches, type Route } from "./router";

const noop = async () => new Response(null);

describe("pathMatches", () => {
	it("matches a single path parameter", () => {
		expect(pathMatches("/machines/:id", "/machines/abc")).toBe(true);
	});

	it("does not let a parameter swallow an extra segment", () => {
		expect(pathMatches("/machines/:id", "/machines/a/b")).toBe(false);
	});
});

describe("findRoute", () => {
	it("reaches the parameterized handler for a concrete id", () => {
		const route = findRoute("DELETE", "/machines/abc");
		expect(route?.path).toBe("/machines/:id");
	});

	it("does not match a path with an extra segment", () => {
		expect(findRoute("DELETE", "/machines/a/b")).toBeUndefined();
	});

	it("prefers an exact route over a parameterized route of the same shape", () => {
		const exactHandler = noop;
		const paramHandler = noop;
		const routes: Route[] = [
			{ method: "GET", path: "/things/:id", handler: paramHandler },
			{ method: "GET", path: "/things/mine", handler: exactHandler },
		];

		const route = findRoute("GET", "/things/mine", routes);
		expect(route?.handler).toBe(exactHandler);
	});
});
