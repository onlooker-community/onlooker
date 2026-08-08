import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs script has no type declarations; it must stay
// directly runnable by node in CI, so it is not rewritten in TypeScript.
import { diffSchema } from "../../scripts/verify-schema.mjs";

const expected = {
	users: {
		columns: [
			{ name: "id", type: "TEXT", notnull: 1, pk: 1 },
			{ name: "email", type: "TEXT", notnull: 1, pk: 0 },
		],
		indexes: ["users_email_idx"],
	},
};

describe("diffSchema", () => {
	it("reports no differences when live matches expected", () => {
		expect(diffSchema(expected, expected)).toEqual([]);
	});

	// The whole point of this verifier is that it can fail. A guard never
	// observed failing is indistinguishable from one that cannot fail - which
	// is exactly the bug being fixed here.
	it("reports a missing table", () => {
		const diffs = diffSchema(expected, {});
		expect(diffs.join(" ")).toMatch(/users/);
		expect(diffs).not.toHaveLength(0);
	});

	it("reports a missing column", () => {
		const live = {
			users: {
				columns: [expected.users.columns[0]],
				indexes: ["users_email_idx"],
			},
		};
		expect(diffSchema(expected, live).join(" ")).toMatch(/email/);
	});

	it("reports a column whose nullability changed", () => {
		const live = structuredClone(expected);
		live.users.columns[1].notnull = 0;
		expect(diffSchema(expected, live).join(" ")).toMatch(/notnull/);
	});

	it("reports a missing index", () => {
		const live = structuredClone(expected);
		live.users.indexes = [];
		expect(diffSchema(expected, live).join(" ")).toMatch(/users_email_idx/);
	});

	it("reports an unexpected extra table", () => {
		const live = { ...expected, audit_logs: { columns: [], indexes: [] } };
		expect(diffSchema(expected, live).join(" ")).toMatch(/audit_logs/);
	});
});
