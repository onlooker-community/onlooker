import { execFileSync } from "node:child_process";

/**
 * Compares two schema descriptions and returns human-readable differences.
 *
 * Comparison is semantic rather than textual. SQLite stores CREATE TABLE text
 * verbatim, including comments, whitespace and ALTER-appended columns, so a
 * string compare would be both noisy and blind to what actually matters.
 */
export function diffSchema(expected, live) {
	const diffs = [];

	for (const [table, spec] of Object.entries(expected)) {
		const actual = live[table];
		if (!actual) {
			diffs.push(`missing table: ${table}`);
			continue;
		}

		for (const col of spec.columns) {
			const found = actual.columns.find((c) => c.name === col.name);
			if (!found) {
				diffs.push(`${table}: missing column ${col.name}`);
				continue;
			}
			for (const key of ["type", "notnull", "pk"]) {
				if (String(found[key]) !== String(col[key])) {
					diffs.push(
						`${table}.${col.name}: ${key} is ${found[key]}, expected ${col[key]}`,
					);
				}
			}
		}

		for (const col of actual.columns) {
			if (!spec.columns.find((c) => c.name === col.name)) {
				diffs.push(`${table}: unexpected column ${col.name}`);
			}
		}

		for (const idx of spec.indexes) {
			if (!actual.indexes.includes(idx)) {
				diffs.push(`${table}: missing index ${idx}`);
			}
		}
		for (const idx of actual.indexes) {
			if (!spec.indexes.includes(idx)) {
				diffs.push(`${table}: unexpected index ${idx}`);
			}
		}
	}

	for (const table of Object.keys(live)) {
		if (!expected[table]) diffs.push(`unexpected table: ${table}`);
	}

	return diffs;
}

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
			indexes: d1Query(
				database,
				env,
				`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND name NOT LIKE 'sqlite_%'`,
			)
				.map((r) => r.name)
				.sort(),
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
		console.error("\nThe live database does not match packages/db/src/schema.ts.");
		process.exit(1);
	}
	console.log(`${database} (${env}) matches packages/db/src/schema.ts`);
}
