// No imports, on purpose. verify-schema.mjs reads the live database through
// wrangler and node:child_process; this comparison is pure, so it lives apart
// and apps/api can run it inside the Workers test runtime against the
// migrated local D1, where node:child_process cannot load (ONL-199).

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
			const found = actual.indexes.find((i) => i.name === idx.name);
			if (!found) {
				diffs.push(`${table}: missing index ${idx.name}`);
				continue;
			}
			if (Boolean(found.unique) !== Boolean(idx.unique)) {
				diffs.push(
					`${table}: index ${idx.name} unique is ${found.unique}, expected ${idx.unique}`,
				);
			}
			// An index that exists, under the right name, with the right
			// uniqueness, over the wrong columns was indistinguishable from a
			// match. The missing-by-name half of a failed index migration was
			// always caught above; this is the half that kept its name.
			//
			// Compared in order, and joined rather than set-compared: a
			// composite index over (a, b) serves queries that one over (b, a)
			// does not, so a reordering is drift.
			//
			// `?? []` on both sides: a snapshot generated before columns were
			// recorded has no `columns` key, and reporting every index in an
			// older snapshot as drift would be a worse failure than the blind
			// spot this closes.
			const wantColumns = (idx.columns ?? []).join(", ");
			const gotColumns = (found.columns ?? []).join(", ");
			if (wantColumns !== gotColumns) {
				diffs.push(
					`${table}: index ${idx.name} covers (${gotColumns}), expected (${wantColumns})`,
				);
			}
		}
		for (const idx of actual.indexes) {
			if (!spec.indexes.find((i) => i.name === idx.name)) {
				diffs.push(`${table}: unexpected index ${idx.name}`);
			}
		}
	}

	for (const table of Object.keys(live)) {
		if (!expected[table]) diffs.push(`unexpected table: ${table}`);
	}

	return diffs;
}
