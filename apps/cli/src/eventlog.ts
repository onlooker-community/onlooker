import {
	closeSync,
	createReadStream,
	existsSync,
	openSync,
	readSync,
} from "node:fs";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { onlookerDir } from "./config";

/**
 * What one pass over `logs/onlooker-events.jsonl` found.
 *
 * Streamed rather than read whole. The log grows at roughly 21MB a month and
 * is already 70MB; `readFileSync` would work today and stop working on a
 * machine nobody is watching, which is the failure mode this command exists to
 * catch. A full streamed pass measures 0.25s at the current size.
 */
export interface EventScan {
	/**
	 * Newest ISO timestamp per `event_type` prefix (the part before the
	 * first dot), from sessions rooted at `root` - machine-wide only when
	 * `root` is `null`, meaning the caller never asked for scoping at all.
	 */
	lastByPrefix: Record<string, string>;
	/** `project_key` values seen on events from sessions rooted at `root`, sorted. */
	projectKeys: string[];
	/**
	 * The session IDs that started in `root`, for a caller (`scanHooks`, via
	 * its own `sessionIds` option) that needs to scope a second source to
	 * the same sessions this join already trusts. Empty when `root` is
	 * `null`.
	 */
	sessionIds: string[];
	/** Lines that would not parse. Counted, never skipped silently. */
	unreadable: number;
	/**
	 * True when the log could not be read: either it could not be opened at
	 * all, or a read that had already started was aborted partway through.
	 * A truncated read is reported the same way as a missing file rather
	 * than as a partial result - see the truncation branch in `scanEvents`
	 * for why a partial pass cannot be trusted downstream.
	 */
	missing: boolean;
}

/**
 * Whether `timestamp` is a well-formed ISO-8601 UTC timestamp - the only
 * shape either log ever writes, verified across 140,000+ event records and
 * 199,000+ hook records.
 *
 * `Date`-parseability alone is not enough, and was this function's first cut:
 * `Date.parse` accepts far looser input than either log ever produces -
 * `"Sep 2 2020"` parses to a real instant and is not `NaN`, but it sorts
 * lexically ABOVE every genuine `2026-…` record and would win
 * `lastByPrefix`'s max exactly the way an unparseable string would. A
 * mixed-offset ISO string (`2026-09-02T10:00:00+02:00`) parses fine too and
 * breaks the same lexical-sort assumption more quietly - every comparison
 * downstream, in this file and in `streams.ts`'s `judge()`, assumes a
 * shared `Z`-suffixed UTC shape sorts the same lexically as it does
 * chronologically. Anything that is not this exact shape is a malformed
 * record, not a real timestamp this module can trust - `unreadable`, not
 * silently kept.
 */
function isValidTimestamp(timestamp: string): boolean {
	return (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(timestamp) &&
		!Number.isNaN(new Date(timestamp).getTime())
	);
}

/**
 * Whether `key` is a real project key - 12 lowercase hex characters, the
 * only shape onlooker's key-hashing scheme ever produces (confirmed: 12
 * distinct such keys across a live 142,855-line event log).
 *
 * Checked here, at the source, rather than in the path-joining code that
 * eventually consumes a project key (`streams.ts`'s `walkKeys`): `key`
 * comes from `payload.project_key`, written by any of sixteen independent
 * shell plugins, and `join(root, key)` normalizes straight out of `root`
 * for a value like `"../busy"` if this field is trusted unchecked. A
 * malformed key must never become a project key in the first place, for
 * every caller downstream - not filtered out later, in one specific
 * caller's own defenses.
 */
function isValidProjectKey(key: string): boolean {
	return /^[0-9a-f]{12}$/.test(key);
}

/**
 * Whether the byte at `offset` (0-indexed) in `path` is a newline.
 *
 * Reads a SPECIFIC, already-written offset - not "the file's current last
 * byte," which keeps moving on a log a hook can append to at any moment.
 * `offset` must be one this process itself already read (see
 * `stream.bytesRead - 1` at both call sites, captured once the read loop
 * has finished) - a byte at a fixed position that has already been written
 * is immutable even if the file keeps growing past it, which is what makes
 * this check race-free in a way re-statting the file's current end is not.
 *
 * This function's first cut queried the file's current end instead
 * (`endsWithNewline(path)`, no offset), *after* the read loop had already
 * finished - both logs are appended continuously, including while a scan
 * runs, so a hook completing a torn line's write (or starting an unrelated
 * new one) between when the read actually finished and when that
 * after-the-fact check ran could flip the answer either way: a genuinely
 * torn line forgiven nothing became `unreadable` because someone else's
 * write happened to complete it moments later, or a genuinely complete
 * line's own unrelated failure got forgiven because a new write happened
 * to be in flight. Reading the fixed offset the read itself reached avoids
 * the race instead of racing to beat it.
 *
 * Returns `true` (treat as complete, today's behavior) for `offset < 0`
 * (nothing was read, so nothing could have been torn) or on any error
 * reading the file - a path this function cannot even check must not
 * silently forgive every malformed line it happens to end with.
 */
export function byteAtOffsetIsNewline(path: string, offset: number): boolean {
	if (offset < 0) return true;
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(1);
			const bytesRead = readSync(fd, buf, 0, 1, offset);
			return bytesRead === 0 || buf[0] === 0x0a; // '\n'
		} finally {
			closeSync(fd);
		}
	} catch {
		return true;
	}
}

/** True when `dir` is `root` itself or sits underneath it. */
function within(dir: unknown, root: string): boolean {
	if (typeof dir !== "string") return false;
	// Strip a trailing separator before comparing: `root + sep` otherwise
	// produces a doubled separator that only the literal string `root`
	// itself can start with. This bites hardest when `root` is a bare "/" -
	// a repository checked out at the filesystem root, which is exactly what
	// `dirname(findUp(cwd, ".git"))` produces there - where every real
	// subdirectory would read as foreign and a live project would be
	// silently reported as having no sessions.
	const stripped = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
	return dir === stripped || dir.startsWith(stripped + sep);
}

export async function scanEvents(opts: {
	root: string | null;
	env?: NodeJS.ProcessEnv;
}): Promise<EventScan> {
	const scan: EventScan = {
		// `Object.create(null)`, not `{}`: an `event_type` prefix of
		// `__proto__` or `constructor` on a plain object literal reads back
		// through `Object.prototype` instead of returning `undefined`, and an
		// assignment through it pollutes every object in the process for the
		// life of the CLI invocation. The event log is untrusted input; the
		// map it drives into must not have a prototype to collide with.
		lastByPrefix: Object.create(null) as Record<string, string>,
		projectKeys: [],
		sessionIds: [],
		unreadable: 0,
		missing: false,
	};

	const path = join(
		onlookerDir(opts.env ?? process.env),
		"logs",
		"onlooker-events.jsonl",
	);
	if (!existsSync(path)) {
		scan.missing = true;
		return scan;
	}

	const mine = new Set<string>();
	// Buffered rather than joined inline: a `project_key` event can arrive
	// before its own `session.start` (a hook that logs ahead of onlooker's
	// does, in most of this repo's own log), so membership in `mine` is not
	// yet decided when the key is seen. Every key is recorded by session and
	// the join happens once, after the pass, against whichever sessions
	// turned out to be ours.
	const keysBySession = new Map<string, Set<string>>();
	// Same reasoning, for `lastByPrefix`: whether a record's own session
	// belongs to `mine` is not decided until the pass is done, so the
	// newest timestamp per prefix is buffered per session first and folded
	// into `scan.lastByPrefix` afterward, once, against only the sessions
	// that turned out to be ours. Only used when `opts.root !== null` -
	// when it is `null` there is no scoping to do, and `lastByPrefix` is
	// still updated directly, machine-wide, exactly as before this field
	// existed.
	const prefixBySession = new Map<string, Record<string, string>>();

	let stream: ReturnType<typeof createReadStream>;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
	} catch {
		// `existsSync` proves the path existed at that instant, not that it can
		// be opened - it may be a directory, or unreadable. Same contract as
		// the readdirSync guards in pipeline.ts: become a reported state.
		scan.missing = true;
		return scan;
	}

	// A single line's worth of parsing/tracking, factored out so the final
	// line of the file can be run through it a beat later than every other
	// line - see the buffering loop below for why. `forgiveFailure` mutes
	// `unreadable` for a parse/shape failure without changing anything else:
	// nothing past that point in a failing line has run yet either way.
	const processLine = (line: string, forgiveFailure = false): void => {
		const trimmed = line.trim();
		if (trimmed === "") return;

		let record: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null) {
				throw new Error("not an object");
			}
			record = parsed as Record<string, unknown>;
		} catch {
			if (!forgiveFailure) scan.unreadable++;
			return;
		}

		const type = record.event_type;
		const timestamp = record.timestamp;
		if (
			typeof type !== "string" ||
			typeof timestamp !== "string" ||
			!isValidTimestamp(timestamp)
		) {
			if (!forgiveFailure) scan.unreadable++;
			return;
		}

		// ISO-8601 in a fixed zone sorts lexically, so string comparison is
		// the right comparison here and costs no date parsing per record.
		const prefix = type.split(".")[0];

		if (opts.root === null) {
			// No root to scope by, so the caller never asked for scoping at
			// all - `lastByPrefix` stays machine-wide, updated directly.
			if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
				scan.lastByPrefix[prefix] = timestamp;
			}
			return;
		}

		const payload = (record.payload ?? {}) as Record<string, unknown>;
		const session = record.session_id;
		// A record with no session cannot be attributed to `mine` or
		// excluded from it, so it cannot inform a session-scoped
		// `lastByPrefix` either - excluded here rather than counted
		// machine-wide as a fallback, the same "cannot measure, no clean
		// bill" reasoning `streams.ts`'s `judge()` applies everywhere else.
		if (typeof session !== "string") return;

		let sessionPrefixes = prefixBySession.get(session);
		if (!sessionPrefixes) {
			sessionPrefixes = Object.create(null) as Record<string, string>;
			prefixBySession.set(session, sessionPrefixes);
		}
		if (timestamp > (sessionPrefixes[prefix] ?? "")) {
			sessionPrefixes[prefix] = timestamp;
		}

		if (
			type === "session.start" &&
			within(payload.working_directory, opts.root)
		) {
			mine.add(session);
		}
		if (
			typeof payload.project_key === "string" &&
			isValidProjectKey(payload.project_key)
		) {
			let sessionKeys = keysBySession.get(session);
			if (!sessionKeys) {
				sessionKeys = new Set();
				keysBySession.set(session, sessionKeys);
			}
			sessionKeys.add(payload.project_key);
		}
	};

	try {
		// One line held back rather than processed as it arrives: only once
		// a second line shows up (or the file ends) do we know the held one
		// was not the file's last line. The log is appended continuously,
		// including while this scan runs, so reaching EOF mid-write is a
		// real race - the truly last line is forgiven a parse/shape failure
		// when the byte at the offset THIS read actually reached says its
		// final write never finished (see `byteAtOffsetIsNewline`); every
		// other line, first through second-to-last, is held to the same
		// standard as always.
		let pendingLine: string | null = null;
		for await (const line of createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		})) {
			if (pendingLine !== null) processLine(pendingLine);
			pendingLine = line;
		}
		if (pendingLine !== null) {
			// `stream.bytesRead - 1`: the offset of the last byte THIS read
			// actually consumed, fixed and already written - not the file's
			// current end, which a concurrent hook can move at any moment
			// between now and whenever this line finishes processing. See
			// `byteAtOffsetIsNewline`'s docstring for why that distinction
			// is the whole fix.
			const forgiveFailure = !byteAtOffsetIsNewline(path, stream.bytesRead - 1);
			processLine(pendingLine, forgiveFailure);
		}
	} catch {
		// `createReadStream` does not throw synchronously for EISDIR/EACCES -
		// the failure can surface here instead, asynchronously, as the loop's
		// first and only error, and there is no way to tell "never actually
		// opened" apart from "opened, then failed after some lines were read"
		// from inside this catch - so both get the same treatment. Either way
		// the pass cannot be told apart from a complete one by anything
		// downstream: `judge()` would compare a truncated `lastByPrefix`
		// against current output mtimes and report live streams as stopped -
		// a false alarm. Refusing to cry wolf is a design commitment this
		// command makes elsewhere (it is why an unenabled-but-writing stream
		// goes in a footer rather than the fault list), so any failure here
		// reports `missing` and discards the data that would drive a verdict.
		// `projectKeys` and `sessionIds` need no reset - they are only
		// assigned after the loop above, so at this point they are still
		// their initial `[]`. `unreadable` is left alone too - a scan can
		// honestly have seen bad lines before a failure like this one.
		scan.missing = true;
		scan.lastByPrefix = Object.create(null) as Record<string, string>;
		return scan;
	}

	scan.sessionIds = [...mine].sort((a, b) => a.localeCompare(b));
	const keys = new Set<string>();
	// `lastByPrefix` folded in from the per-session buffer here too, once,
	// against only the sessions that turned out to be `mine` - see
	// `prefixBySession`'s own comment. A no-op when `opts.root === null`:
	// `prefixBySession` was never populated in that branch, since
	// `lastByPrefix` was already updated directly, machine-wide, inline.
	for (const session of mine) {
		const sessionPrefixes = prefixBySession.get(session);
		if (sessionPrefixes) {
			for (const prefix of Object.keys(sessionPrefixes)) {
				const timestamp = sessionPrefixes[prefix];
				if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
					scan.lastByPrefix[prefix] = timestamp;
				}
			}
		}
		for (const key of keysBySession.get(session) ?? []) {
			keys.add(key);
		}
	}
	scan.projectKeys = [...keys].sort((a, b) => a.localeCompare(b));
	return scan;
}

/**
 * What one pass over `logs/hook-health.jsonl` found, per hook.
 *
 * Only the 21 hooks that write health records appear here. This file is not a
 * registry of streams and must never be used as one: six plugins that stopped
 * on 2026-08-07 have zero records across all 199,103 entries, so "no failures"
 * would give six dead streams a clean bill.
 */
export interface HookScan {
	hooks: Record<string, { firedSince: number; okSince: number; last: string }>;
	unreadable: number;
	missing: boolean;
}

export async function scanHooks(opts: {
	/** Hook name to the ISO timestamp its output last moved. Absent means count all. */
	since: Record<string, string>;
	/**
	 * Only firings whose `session_id` is in this set count, when provided -
	 * `scanEvents`'s own `sessionIds`, so a hook's firing count reflects
	 * this repo's own sessions rather than every session on the machine.
	 * Omitted entirely (not an empty array) means no scoping was requested
	 * at all: every firing counts, machine-wide, exactly as before this
	 * option existed - the every-call-site-in-this-file default until a
	 * caller opts in.
	 */
	sessionIds?: readonly string[];
	env?: NodeJS.ProcessEnv;
}): Promise<HookScan> {
	const scan: HookScan = {
		// `Object.create(null)`, not `{}`: same hazard as `lastByPrefix` in
		// `scanEvents` above, and a hook name is exactly as untrusted as an
		// event-type prefix. A hook literally named `__proto__` or
		// `constructor` must not resolve through `Object.prototype`.
		hooks: Object.create(null) as Record<
			string,
			{ firedSince: number; okSince: number; last: string }
		>,
		unreadable: 0,
		missing: false,
	};

	const path = join(
		onlookerDir(opts.env ?? process.env),
		"logs",
		"hook-health.jsonl",
	);
	if (!existsSync(path)) {
		scan.missing = true;
		return scan;
	}

	let stream: ReturnType<typeof createReadStream>;
	try {
		stream = createReadStream(path, { encoding: "utf8" });
	} catch {
		scan.missing = true;
		return scan;
	}

	// `undefined` means "no scoping requested" (every existing call site in
	// this file); a real array, even an empty one, means "scope to exactly
	// this set" - see `opts.sessionIds`'s own docstring.
	const scoped =
		opts.sessionIds === undefined ? null : new Set(opts.sessionIds);

	// See `scanEvents`'s identical `processLine` for why the final line is
	// held back and run through this a beat later than every other line.
	const processLine = (line: string, forgiveFailure = false): void => {
		const trimmed = line.trim();
		if (trimmed === "") return;

		let record: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed === null)
				throw new Error("not an object");
			record = parsed as Record<string, unknown>;
		} catch {
			if (!forgiveFailure) scan.unreadable++;
			return;
		}

		const hook = record.hook;
		const timestamp = record.timestamp;
		if (
			typeof hook !== "string" ||
			typeof timestamp !== "string" ||
			!isValidTimestamp(timestamp)
		) {
			if (!forgiveFailure) scan.unreadable++;
			return;
		}

		// Out-of-scope firings are excluded entirely, not merely uncounted:
		// a hook that only ever fired in other sessions never gets a
		// `scan.hooks[hook]` entry at all, so it reads to a caller exactly
		// like a hook with no records - `undefined`, not `{ firedSince: 0,
		// ... }` - which is what "we have no evidence of OUR OWN activity"
		// actually means. A record with no `session_id` cannot be
		// attributed to `scoped` either way, so it is excluded the same as
		// one that is attributable but not ours - the reviewer's
		// reproduction (a single unrelated session's firing) is exactly
		// this shape, just attributable.
		if (scoped !== null) {
			const session = record.session_id;
			if (typeof session !== "string" || !scoped.has(session)) return;
		}

		if (!scan.hooks[hook])
			scan.hooks[hook] = { firedSince: 0, okSince: 0, last: "" };
		const entry = scan.hooks[hook];
		if (timestamp > entry.last) entry.last = timestamp;

		// No threshold means nothing downstream to lag behind, so every
		// firing counts. Defaulting the other way would zero out every
		// stream whose table entry has no output path. `since` is a plain
		// object supplied by the caller, not one of ours to make
		// prototype-free - `since[hook]` for `hook === "__proto__"` would
		// resolve to `Object.prototype` instead of `undefined`, so
		// existence is decided with `hasOwn` rather than a truthy/
		// not-undefined check on the lookup itself.
		//
		// Parsed epoch milliseconds, not a lexical string compare:
		// `since[hook]` comes from `mtimeToIso` (`Date#toISOString()`,
		// always millisecond precision), but this log writes second
		// precision - lexically `"…:45Z"` sorts ABOVE `"…:45.123Z"`
		// (`'Z'` is 0x5A, `'.'` is 0x2E), so the hook run that produced
		// the output, or any run in the same second, would count as
		// "since" under a string compare even when it fired at or
		// before the output's own mtime - a systematic +1 on
		// `firedSince` against a threshold of 5. Both sides are
		// guaranteed to parse by this point: `timestamp` by
		// `isValidTimestamp` above, `since[hook]` by construction in
		// `streams.ts`.
		if (
			Object.hasOwn(opts.since, hook) &&
			new Date(timestamp).getTime() <= new Date(opts.since[hook]).getTime()
		)
			return;

		entry.firedSince++;
		if (record.status === "success") entry.okSince++;
	};

	try {
		// See `scanEvents` for why one line is held back rather than
		// processed inline - the log is appended continuously here too, so
		// the same mid-write race applies.
		let pendingLine: string | null = null;
		for await (const line of createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		})) {
			if (pendingLine !== null) processLine(pendingLine);
			pendingLine = line;
		}
		if (pendingLine !== null) {
			// See `scanEvents` for why this reads the offset the stream
			// itself actually reached, not the file's current end.
			const forgiveFailure = !byteAtOffsetIsNewline(path, stream.bytesRead - 1);
			processLine(pendingLine, forgiveFailure);
		}
	} catch {
		// Same asymmetry as scanEvents: createReadStream does not throw
		// synchronously for EISDIR/EACCES, so the failure can surface here
		// instead, asynchronously, as the loop's first and only error, and
		// there is no way to tell "never actually opened" apart from
		// "opened, then failed after some lines were read" from inside this
		// catch. Unlike scanEvents there is no derived verdict here to
		// mistakenly trust either way - firedSince/okSince/last are just
		// undercounts of a scan that did not finish, so any failure here
		// reports `missing` and discards them rather than handing a caller a
		// table that looks complete but is not.
		scan.missing = true;
		scan.hooks = Object.create(null) as Record<
			string,
			{ firedSince: number; okSince: number; last: string }
		>;
		return scan;
	}

	return scan;
}
