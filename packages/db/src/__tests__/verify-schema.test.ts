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
		indexes: [{ name: "users_email_idx", unique: true, columns: ["email"] }],
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
				indexes: [{ name: "users_email_idx", unique: true }],
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

	// The exact defect production had: an index present under the right name
	// but missing UNIQUE. A name-only comparison would call this a match.
	it("reports a uniqueness mismatch on an index that matches by name", () => {
		const live = structuredClone(expected);
		live.users.indexes[0].unique = false;
		const diffs = diffSchema(expected, live);
		expect(diffs.join(" ")).toMatch(/users_email_idx/);
		expect(diffs.join(" ")).toMatch(/unique/);
	});

	it("reports an unexpected extra table", () => {
		const live = { ...expected, audit_logs: { columns: [], indexes: [] } };
		expect(diffSchema(expected, live).join(" ")).toMatch(/audit_logs/);
	});

	// The dangerous half of an index migration IS already caught: if the DROP
	// commits and the CREATE fails, the index goes missing by name, and that
	// is checked above. The gap is specifically wrong-columns-same-name - an
	// index that exists, under the right name, with the right uniqueness,
	// over the wrong columns. Nothing distinguished that from a match.
	it("reports an index whose columns changed under the same name", () => {
		const live = structuredClone(expected);
		live.users.indexes[0].columns = ["email_normalized"];
		const diffs = diffSchema(expected, live);
		expect(diffs.join(" ")).toMatch(/users_email_idx/);
		expect(diffs.join(" ")).toMatch(/email_normalized/);
	});

	// Order is part of the index, not an incidental detail of how it is
	// listed: a composite index over (a, b) serves queries that one over
	// (b, a) does not.
	it("reports a composite index whose column order changed", () => {
		const composite = {
			users: {
				columns: expected.users.columns,
				indexes: [
					{ name: "users_pair_idx", unique: false, columns: ["a", "b"] },
				],
			},
		};
		const live = structuredClone(composite);
		live.users.indexes[0].columns = ["b", "a"];
		expect(diffSchema(composite, live)).not.toHaveLength(0);
	});
});
