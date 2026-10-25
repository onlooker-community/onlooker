import { execFileSync } from "node:child_process";
import { diffSchema } from "./diff-schema.mjs";

// Re-exported so existing importers keep working. The comparison lives in
// diff-schema.mjs, which has no node imports, so apps/api can run it against
// its migrated local D1 before merge (ONL-199).
export { diffSchema };

/**
 * Tables Cloudflare and wrangler create. Our source does not declare them, so
 * they are not drift.
 */
const IGNORED = (name) =>
	name.startsWith("sqlite_") ||
	name.startsWith("_cf_") ||
	name === "d1_migrations";

function d1Query(database, env, sql) {
	const out = execFileSync(
		"pnpm",
		[
			"--filter",
			"@onlooker/api",
			"exec",
			"wrangler",
			"d1",
			"execute",
			database,
			"--env",
			env,
			"--remote",
			"--json",
			"--command",
			sql,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out)[0].results;
}

export function readLiveSchema(database, env) {
	const tables = d1Query(
		database,
		env,
		"SELECT name FROM sqlite_master WHERE type='table'",
	)
		.map((r) => r.name)
		.filter((n) => !IGNORED(n));

	const live = {};
	for (const table of tables) {
		live[table] = {
			// Types are normalized to upper case here to match the normalization
			// generate-expected-schema.mjs applies, since SQLite reports whatever
			// case the CREATE statement used and that is not worth failing a
			// deploy over.
			columns: d1Query(database, env, `PRAGMA table_info(${table})`).map(
				(c) => ({
					name: c.name,
					type: c.type.toUpperCase(),
					notnull: c.notnull,
					pk: c.pk,
				}),
			),
			// index_list (not sqlite_master) so uniqueness travels with the name -
			// a live index that matches by name but isn't UNIQUE is exactly the
			// defect production had (see schema.ts on sessions_token_hash_idx),
			// and a name-only comparison would pass it silently.
			//
			// index_info per index for the columns, because index_list does
			// not carry them - one extra remote round-trip per index, paid at
			// deploy time rather than per request. `seqno` is the position
			// within the index, so ordering by it preserves the composite
			// order the expectation pins.
			indexes: d1Query(database, env, `PRAGMA index_list(${table})`)
				.filter((r) => !r.name.startsWith("sqlite_"))
				.map((r) => ({
					name: r.name,
					unique: Boolean(r.unique),
					columns: d1Query(database, env, `PRAGMA index_info(${r.name})`)
						.sort((a, b) => a.seqno - b.seqno)
						.map((c) => c.name),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
	}
	return live;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [database, env] = process.argv.slice(2);
	const { EXPECTED_SCHEMA } = await import("../dist/expected-schema.js");
	const diffs = diffSchema(EXPECTED_SCHEMA, readLiveSchema(database, env));

	if (diffs.length > 0) {
		console.error(`Schema drift in ${database} (${env}):\n`);
		for (const d of diffs) console.error(`  - ${d}`);
		console.error(
			"\nThe live database does not match packages/db/src/schema.ts.",
		);
		process.exit(1);
	}
	console.log(`${database} (${env}) matches packages/db/src/schema.ts`);
}
