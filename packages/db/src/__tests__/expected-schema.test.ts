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

	// Recording an index by name and uniqueness alone left the snapshot
	// byte-identical after an index-COLUMN change, so the staleness test above
	// could never fail on one - and `verify-schema` had nothing to compare, so
	// the deploy check was blind to the same change. Pinned on a real index
	// rather than a synthetic one: whatever else moves in schema.ts, an index
	// that records no columns fails here.
	it("records the columns each index covers", () => {
		const users = generateExpectedSchema().users;
		const emailIdx = users.indexes.find(
			(i: { name: string }) => i.name === "users_email_idx",
		);
		expect(emailIdx).toBeDefined();
		expect(emailIdx.columns).toEqual(["email"]);
	});

	it("records index columns for every index in the schema", () => {
		for (const [table, spec] of Object.entries(generateExpectedSchema())) {
			for (const index of (
				spec as { indexes: Array<{ name: string; columns?: unknown }> }
			).indexes) {
				expect(
					Array.isArray(index.columns) && index.columns.length > 0,
					`${table}.${index.name} records no columns`,
				).toBe(true);
			}
		}
	});
});
