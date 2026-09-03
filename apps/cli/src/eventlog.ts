import { createReadStream, existsSync } from "node:fs";
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
	/** Newest ISO timestamp per `event_type` prefix (the part before the first dot). */
	lastByPrefix: Record<string, string>;
	/** `project_key` values seen on events from sessions rooted at `root`, sorted. */
	projectKeys: string[];
	/** How many sessions started in `root`. */
	sessions: number;
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
		sessions: 0,
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

	try {
		for await (const line of createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		})) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			let record: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (typeof parsed !== "object" || parsed === null) {
					throw new Error("not an object");
				}
				record = parsed as Record<string, unknown>;
			} catch {
				scan.unreadable++;
				continue;
			}

			const type = record.event_type;
			const timestamp = record.timestamp;
			if (typeof type !== "string" || typeof timestamp !== "string") {
				scan.unreadable++;
				continue;
			}

			// ISO-8601 in a fixed zone sorts lexically, so string comparison is
			// the right comparison here and costs no date parsing per record.
			const prefix = type.split(".")[0];
			if (timestamp > (scan.lastByPrefix[prefix] ?? "")) {
				scan.lastByPrefix[prefix] = timestamp;
			}

			if (opts.root === null) continue;
			const payload = (record.payload ?? {}) as Record<string, unknown>;
			const session = record.session_id;
			if (typeof session !== "string") continue;

			if (
				type === "session.start" &&
				within(payload.working_directory, opts.root)
			) {
				mine.add(session);
			}
			if (typeof payload.project_key === "string") {
				let sessionKeys = keysBySession.get(session);
				if (!sessionKeys) {
					sessionKeys = new Set();
					keysBySession.set(session, sessionKeys);
				}
				sessionKeys.add(payload.project_key);
			}
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
		// `projectKeys` and `sessions` need no reset - they are only assigned
		// after the loop above, so at this point they are still their initial
		// `[]`/`0`. `unreadable` is left alone too - a scan can honestly have
		// seen bad lines before a failure like this one.
		scan.missing = true;
		scan.lastByPrefix = Object.create(null) as Record<string, string>;
		return scan;
	}

	scan.sessions = mine.size;
	const keys = new Set<string>();
	for (const session of mine) {
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

	try {
		for await (const line of createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		})) {
			const trimmed = line.trim();
			if (trimmed === "") continue;

			let record: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (typeof parsed !== "object" || parsed === null)
					throw new Error("not an object");
				record = parsed as Record<string, unknown>;
			} catch {
				scan.unreadable++;
				continue;
			}

			const hook = record.hook;
			const timestamp = record.timestamp;
			if (typeof hook !== "string" || typeof timestamp !== "string") {
				scan.unreadable++;
				continue;
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
			if (Object.hasOwn(opts.since, hook) && timestamp <= opts.since[hook])
				continue;

			entry.firedSince++;
			if (record.status === "success") entry.okSince++;
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
