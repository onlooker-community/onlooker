/**
 * The lesson contract's comparator grammar, evaluated without a dependency.
 *
 * `apps/cli` has exactly one runtime dependency - the contract itself - and
 * this keeps it that way. `VERSION_RANGE` is deliberately narrow:
 * comparator-prefixed, at most a lower and an upper bound, with a bare "4"
 * rejected because it is ambiguous about whether it means "exactly 4". A
 * grammar that small is honestly implementable here, and a general semver
 * engine would be the larger change rather than the smaller one.
 */
export type RangeVerdict = "satisfied" | "unsatisfied" | "unparseable";

/**
 * `6.0.0-beta.1` to `[6, 0, 0]`. Null when there is no numeric core.
 *
 * Prereleases compare on their core because someone running a 6 prerelease is
 * on 6 for the purpose of a lesson scoped `<6`. The other reading keeps a
 * retired lesson alive for exactly the people most likely to meet whatever
 * replaced it.
 */
function numericCore(version: string): [number, number, number] | null {
	const core = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
	if (!core) return null;
	return [Number(core[1]), Number(core[2] ?? 0), Number(core[3] ?? 0)];
}

/** Negative, zero or positive, comparing component by component. */
function compare(
	a: [number, number, number],
	b: [number, number, number],
): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

/**
 * Does `installed` fall inside `range`?
 *
 * Three outcomes rather than a boolean. `unparseable` is what lets the caller
 * report "cannot tell" instead of inventing an answer - and inventing one is
 * dangerous in a specific direction: skipping a constraint we could not
 * evaluate produces a lesson that never expires, which is the failure
 * `applies-to.ts` warns about by name.
 */
export function satisfies(installed: string, range: string): RangeVerdict {
	const version = numericCore(installed);
	if (version === null) return "unparseable";

	const clauses = range.trim().split(/\s+/).filter(Boolean);
	if (clauses.length === 0) return "unparseable";

	for (const clause of clauses) {
		const parsed = /^(>=|<=|>|<)(.+)$/.exec(clause);
		// A clause with no comparator is the ambiguous case the contract
		// rejects at ingest. Reaching here means something upstream accepted
		// what it should not have, and picking a meaning would hide that.
		if (!parsed) return "unparseable";

		const bound = numericCore(parsed[2]);
		if (bound === null) return "unparseable";

		const diff = compare(version, bound);
		const ok =
			parsed[1] === "<"
				? diff < 0
				: parsed[1] === "<="
					? diff <= 0
					: parsed[1] === ">"
						? diff > 0
						: diff >= 0;
		// Every clause must hold: returning on the first satisfied one would
		// call 9.0.0 applicable to ">=4 <6".
		if (!ok) return "unsatisfied";
	}

	return "satisfied";
}
