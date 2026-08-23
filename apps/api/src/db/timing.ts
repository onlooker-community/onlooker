import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

/**
 * Wraps a D1 binding so every query reports how long it took, split into the
 * part D1 spent executing and the part that was the trip to reach it.
 *
 * onlooker-ujy found a d1_all span at 100 ms whose own execution was 0.3078 ms -
 * worker in LAX, database in MIA - so ~99.7% of what read as database time was
 * the round trip, and tuning the query would recover nothing. That was n=2, and
 * getting past n=2 turned out to be harder than expected.
 *
 * The obvious route does not work. Workers tracing records those spans and the
 * dashboard's Traces tab shows them, but they are NOT reachable through the
 * observability telemetry query API: that dataset's key list contains no
 * cloudflare.d1.* field of any kind, and no event in it carries a spanName.
 * Probed directly on 2026-08-23 against production. The Traces tab reads a
 * different backend, so anything automated against it is a dead end.
 *
 * So this measures the same thing from inside, where the numbers are ours:
 *
 *   wall  - how long the Worker actually waited
 *   exec  - meta.duration, which is D1's own report of execution time
 *   trip  - wall - exec, the part that is neither the query nor the client
 *
 * `trip` is the number the bead is about. It is a lower bound on the round trip
 * rather than an exact one - `wall` also contains serialization and whatever
 * else sits between the binding and the wire - but at a 100 ms span against a
 * 0.3 ms execution, that distinction does not change any decision.
 *
 * Wrapping the binding rather than the call sites is deliberate: drizzle reaches
 * D1 through the same prepare(), so one wrapper covers both the drizzle query
 * layer in queries.ts and the raw statements in lessons.ts, with no call site
 * needing to know. Verified by probe before this was written - a Proxy over the
 * binding survives, meta.duration is present, and drizzle's calls do pass
 * through it.
 */

/** What a timed query reports. Every field is a number the log can be read on. */
export interface D1Timing {
	/** How long the Worker waited, in milliseconds. */
	wallMs: number;
	/** D1's own execution time from meta.duration, in milliseconds. */
	execMs: number | null;
	/** wallMs - execMs. Null when D1 reported no duration. */
	tripMs: number | null;
	/** Rows the query read, from meta.rows_read. */
	rowsRead: number | null;
}

/**
 * The first word of a SQL statement, which is all the label needs to be.
 *
 * Deliberately NOT the whole statement. Query text can carry bound-looking
 * fragments and this ends up in logs that are readable by anyone who can read
 * the account's telemetry; a verb is enough to tell a read from a write when
 * reading a distribution.
 */
function verbOf(query: string): string {
	const match = /^\s*(\w+)/.exec(query);
	return match ? match[1].toUpperCase() : "UNKNOWN";
}

/**
 * Emit one timing line.
 *
 * console.error, not console.log, and the shape matters. Workers Logs parses a
 * JSON string handed to console.error into individually queryable top-level
 * keys, which is what makes `event` filterable - the same mechanism the client
 * error monitor depends on. A bare string, or an object rather than a string,
 * would land as an unqueryable blob.
 *
 * Errors are swallowed: a logging failure must never take down the query it was
 * measuring.
 */
function report(verb: string, timing: D1Timing): void {
	try {
		console.error(
			JSON.stringify({
				event: "d1_timing",
				verb,
				wall_ms: Math.round(timing.wallMs * 1000) / 1000,
				exec_ms: timing.execMs,
				trip_ms:
					timing.tripMs === null ? null : Math.round(timing.tripMs * 1000) / 1000,
				rows_read: timing.rowsRead,
			}),
		);
	} catch {
		// Measurement is not worth an outage.
	}
}

function timingFrom(started: number, meta: unknown): D1Timing {
	const wallMs = Date.now() - started;
	const record = (meta ?? {}) as Record<string, unknown>;

	const execMs = typeof record.duration === "number" ? record.duration : null;
	const rowsRead =
		typeof record.rows_read === "number" ? record.rows_read : null;

	return {
		wallMs,
		execMs,
		// Clamped at zero. exec is reported by D1 and wall is measured here, so
		// on a very fast query clock granularity can make exec look larger; a
		// negative round trip is noise, not a finding.
		tripMs: execMs === null ? null : Math.max(0, wallMs - execMs),
		rowsRead,
	};
}

/** The statement methods that actually execute and return metadata. */
const TIMED_METHODS = new Set(["first", "all", "run", "raw"]);

function timedStatement(
	statement: D1PreparedStatement,
	verb: string,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;

			// bind() returns a new statement, so the wrapper has to follow it or
			// timing is lost on every parameterized query - which is all of them.
			if (prop === "bind") {
				return (...args: unknown[]) =>
					timedStatement(
						(value as (...a: unknown[]) => D1PreparedStatement).apply(
							target,
							args,
						),
						verb,
					);
			}

			if (!TIMED_METHODS.has(String(prop))) return value.bind(target);

			return async (...args: unknown[]) => {
				const started = Date.now();
				const result = await (
					value as (...a: unknown[]) => Promise<unknown>
				).apply(target, args);

				// raw() returns arrays with no meta; it still gets a wall time.
				const meta = (result as { meta?: unknown } | null)?.meta;
				report(verb, timingFrom(started, meta));

				return result;
			};
		},
	});
}

/**
 * Return a D1 binding that logs a timing line for every query it runs.
 *
 * batch() is timed as one operation, which is correct: its statements share a
 * transaction and a single round trip, so timing them individually would invent
 * a distinction that does not exist.
 */
export function timedD1(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;

			if (prop === "prepare") {
				return (query: string) =>
					timedStatement(target.prepare(query), verbOf(query));
			}

			if (prop === "batch") {
				return async (...args: unknown[]) => {
					const started = Date.now();
					const results = (await (
						value as (...a: unknown[]) => Promise<unknown>
					).apply(target, args)) as Array<{ meta?: unknown }>;

					// One line for the batch, using the first statement's meta for
					// exec time. Each statement reports its own duration, but they
					// were executed together, so summing them would double-count the
					// single trip this is trying to isolate.
					report("BATCH", timingFrom(started, results?.[0]?.meta));

					return results;
				};
			}

			return value.bind(target);
		},
	});
}
