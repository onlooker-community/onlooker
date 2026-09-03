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
	/** True when the log could not be opened at all. */
	missing: boolean;
}

/** True when `dir` is `root` itself or sits underneath it. */
function within(dir: unknown, root: string): boolean {
	return (
		typeof dir === "string" && (dir === root || dir.startsWith(root + sep))
	);
}

export async function scanEvents(opts: {
	root: string | null;
	env?: NodeJS.ProcessEnv;
}): Promise<EventScan> {
	const scan: EventScan = {
		lastByPrefix: {},
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

	let linesRead = 0;
	try {
		for await (const line of createInterface({
			input: stream,
			crlfDelay: Number.POSITIVE_INFINITY,
		})) {
			linesRead++;
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
		// the failure surfaces here instead, asynchronously, as the loop's
		// first and only error. Zero lines read means the stream was never
		// actually opened, which is the same "could not be read" outcome as
		// a missing file.
		if (linesRead === 0) {
			scan.missing = true;
			return scan;
		}

		// A failure after some lines were read leaves a genuinely partial
		// pass, and a partial pass cannot be told apart from a complete one
		// by anything downstream: `judge()` would compare the truncated
		// `lastByPrefix` timestamps against current output mtimes and report
		// live streams as stopped - a false alarm. Refusing to cry wolf is a
		// design commitment this command makes elsewhere (it is why an
		// unenabled-but-writing stream goes in a footer rather than the
		// fault list), so a truncated pass reports `missing` and discards
		// the data that would drive a verdict. `unreadable` is left alone -
		// a scan can honestly be both truncated and have seen bad lines
		// before the abort.
		scan.missing = true;
		scan.lastByPrefix = {};
		scan.projectKeys = [];
		scan.sessions = 0;
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
