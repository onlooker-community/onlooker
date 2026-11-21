import { describe, expect, it } from "vitest";
import { LOCAL_API, LOCAL_DATABASE, wranglerArgs } from "./local";

// Replaces the CI step that ran scripts/seed-dev-projects.test.sh: the seed
// must never be able to reach a database or API other than the local ones.
describe("the seed's target", () => {
	it("only ever runs wrangler against the local development database", () => {
		const args = wranglerArgs("/tmp/seed.sql");

		expect(args).toEqual([
			"--filter",
			"@onlooker/api",
			"exec",
			"wrangler",
			"d1",
			"execute",
			"onlooker-db-local",
			"--local",
			"--env",
			"development",
			"--file",
			"/tmp/seed.sql",
		]);
		expect(args).not.toContain("--remote");
		expect(LOCAL_DATABASE).toBe("onlooker-db-local");
	});

	it("only ever talks to the API on localhost", () => {
		expect(new URL(LOCAL_API).hostname).toBe("localhost");
		expect(LOCAL_API).toBe("http://localhost:8787");
	});
});
