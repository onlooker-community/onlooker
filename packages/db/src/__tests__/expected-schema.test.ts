import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs script has no type declarations; it must stay
// directly runnable by node in CI, so it is not rewritten in TypeScript.
import { generateExpectedSchema } from "../../scripts/generate-expected-schema.mjs";
import { EXPECTED_SCHEMA } from "../expected-schema.js";

describe("expected-schema.ts", () => {
	// Mirrors the guard in packages/lesson-contract/src/json-schema.test.ts:
	// the committed snapshot is compared against one derived fresh from the
	// drizzle schema, so it cannot go stale.
	it("matches a freshly generated snapshot of the drizzle schema", () => {
		expect(EXPECTED_SCHEMA).toEqual(generateExpectedSchema());
	});
});
