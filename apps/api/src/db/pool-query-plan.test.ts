import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { readPool } from "./pool.js";

/**
 * What the planner does with the pool read.
 *
 * Every other test in this directory asks what a read RETURNS. This one asks
 * how SQLite gets there, because the widening that opened the pool to other
 * accounts' public lessons also cost the read its index: the leading clause
 * became a disjunction (`visibility = 'public' OR user_id = ?`), and with no
 * index on `visibility` SQLite cannot do its OR-to-index-union rewrite, so it
 * falls back to reading every row of every user's lessons and sorting them.
 *
 * That is invisible to a correctness test and invisible in review, and it is
 * free today only because production has no lesson volume at all - no machine
 * token exists there, so nothing has ever been pushed. "Nothing fails if it is
 * forgotten" is exactly why onlooker-wi9ftq.1.7 was filed rather than left as
 * a comment, and this file is the part that makes forgetting it fail.
 *
 * THE SQL IS CAPTURED, NEVER RETYPED. A test that spelled the query out again
 * would plan a copy: `readPool` could lose its index and this would still pass
 * against the string in the test file. The recorder below is handed to the
 * real `readPool` as its D1 handle, so what gets explained is what production
 * runs.
 */

/** The statement `readPool` prepared, with the values it bound. */
interface Captured {
	sql: string;
	binds: unknown[];
}

/**
 * A D1 stand-in that answers nothing and remembers the question.
 *
 * `readPool` calls `prepare(...).bind(...).all()` once and reads `results`, so
 * an empty page is a complete answer - this never needs to return rows, only
 * to survive the call and keep the SQL.
 */
function recorder(): { captured: Captured[]; db: D1Database } {
	const captured: Captured[] = [];
	const db = {
		prepare(sql: string) {
			return {
				bind(...binds: unknown[]) {
					captured.push({ sql, binds });
					return {
						all: async () => ({ results: [] }),
						first: async () => null,
					};
				},
			};
		},
	};
	return { captured, db: db as unknown as D1Database };
}

/** The plan SQLite produces for a statement, one `detail` string per row. */
async function planFor({ sql, binds }: Captured): Promise<string[]> {
	const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...binds)
		.all<{ detail: string }>();
	return (results ?? []).map((row) => row.detail);
}

/** What `readPool` prepares for an ordinary signed-in browse. */
async function planForAuthenticatedBrowse(): Promise<string[]> {
	const { captured, db } = recorder();
	await readPool(db, { userId: "u1" }, { limit: 50 });
	expect(captured).toHaveLength(1);
	return planFor(captured[0]);
}

/** What `readPool` prepares for a signed-in browse by a member of two orgs. */
async function planForOrgBrowse(): Promise<string[]> {
	const { captured, db } = recorder();
	await readPool(db, { userId: "u1" }, { limit: 50 }, async () => [
		"org-a",
		"org-b",
	]);
	expect(captured).toHaveLength(1);
	return planFor(captured[0]);
}

describe("the pool read's query plan", () => {
	// The regression itself. `SCAN lessons` means every row of every user's
	// lessons is read to answer one person's first page.
	it("does not scan the whole lessons table", async () => {
		const plan = await planForAuthenticatedBrowse();

		expect(plan.join("\n")).not.toMatch(/\bSCAN lessons\b/);
	});

	// The positive half, so the guard cannot pass by the table ceasing to be
	// read at all - a query that stopped touching `lessons` would satisfy the
	// assertion above and be a much worse bug.
	//
	// Matched against `lessons` specifically, not against any index anywhere
	// in the plan. The blocklist's NOT EXISTS already contributes a line
	// reading "SEARCH b USING COVERING INDEX ...", so a bare /USING INDEX/
	// passes while the main table is still being scanned end to end - which
	// is exactly what this assertion did on its first run.
	it("reaches the lesson rows through an index", async () => {
		const plan = await planForAuthenticatedBrowse();

		expect(plan.join("\n")).toMatch(/SEARCH lessons USING (COVERING )?INDEX/);
	});

	// Named, because which index answers this is the whole point: the
	// disjunction needs one on `visibility` before SQLite will consider the
	// union rewrite at all.
	//
	// Two visibility-leading indexes exist now - lessons_visibility_promoted_
	// at_idx and lessons_visibility_org_promoted_at_idx, added for the org
	// browse (see "The index, measured" in the design spec) - and either can
	// legitimately answer this branch: both carry `visibility` as their first
	// column, so either resolves the union rewrite. The regex below accepts
	// both on purpose. Which one SQLite actually picks is a cost-model
	// tie-break, not a property of our schema, and pinning one name would
	// make this test depend on SQLite's internals rather than on the
	// property we care about - that the branch is seekable on `visibility`,
	// not scanned.
	//
	// Loosening this does not leave index existence unguarded:
	// packages/db/src/expected-schema.ts records the shape of every index,
	// including both of these, and is checked against the deployed schema.
	// If either index vanished, that check would fail independently of
	// anything asserted here.
	it("uses a visibility-leading index for the public disjunct", async () => {
		const plan = await planForAuthenticatedBrowse();

		expect(plan.join("\n")).toMatch(
			/lessons_visibility_(?:org_)?promoted_at_idx/,
		);
	});

	/**
	 * The anonymous read has no disjunction to union - its predicate is a bare
	 * `visibility = 'public'` - so the same index should answer it outright,
	 * and this is the path a public lesson link actually takes.
	 */
	it("answers the anonymous read from the same index", async () => {
		const { captured, db } = recorder();
		await readPool(db, null, { limit: 50 });

		const plan = (await planFor(captured[0])).join("\n");
		expect(plan).not.toMatch(/\bSCAN lessons\b/);
		expect(plan).toMatch(/lessons_visibility_promoted_at_idx/);
	});

	it("does not scan the whole lessons table for an org member", async () => {
		const plan = await planForOrgBrowse();

		expect(plan.join("\n")).not.toMatch(/\bSCAN lessons\b/);
	});

	it("reaches the lesson rows through an index for an org member", async () => {
		// The positive half, so the guard cannot pass by the table ceasing to
		// be read at all. Matched against `lessons` specifically: the
		// blocklist's NOT EXISTS contributes its own "USING COVERING INDEX"
		// line, so a bare /USING INDEX/ passes while the table is scanned end
		// to end.
		const plan = await planForOrgBrowse();

		expect(plan.join("\n")).toMatch(/SEARCH lessons USING (COVERING )?INDEX/);
	});

	// Named, because which index answers the org branch is the whole point of
	// 0012_classy_dreaming_celestial.sql: measured without it, the org branch
	// seeks on `visibility=?` alone and relies on an in-memory filter for
	// `org_id`; measured with it, the seek matches `visibility=? AND
	// org_id=?` directly - see "The index, measured" in
	// docs/superpowers/specs/2026-10-04-org-visibility-tier-design.md.
	it("seeks the org branch on both visibility and org_id", async () => {
		const plan = await planForOrgBrowse();

		expect(plan.join("\n")).toMatch(
			/lessons_visibility_org_promoted_at_idx \(visibility=\? AND org_id=\?\)/,
		);
	});
});
