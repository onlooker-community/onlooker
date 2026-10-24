/**
 * One session, folded down to what may leave the machine.
 *
 * The envelope only. `payload` is absent from `EventEnvelope` deliberately, and
 * that absence is the feature's entire safety story: a plugin shipping a new
 * event type cannot leak through this path, because no code here reads what its
 * events contain. The alternative - an allowlist of safe payload fields - would
 * be richer, and would have to be re-decided every time somebody adds an event
 * type, with the default for an undecided type being where the leak lives.
 *
 * The cost is stated rather than hidden: a summary reading "6,311 tool events
 * over two hours" reports THAT something happened, not what. See the design.
 */
export interface EventEnvelope {
	event_type: string;
	session_id: string;
	timestamp: string;
	machine_id?: string;
	plugin?: string;
	/**
	 * The repository this event is attributable to: an opaque 12-hex key, never
	 * a path or a repo name. Byte-identical to the on-disk directory name under
	 * `$ONLOOKER_DIR/<plugin>/<key>/`, which is what lets a hosted row join to
	 * local artifacts.
	 *
	 * Absent means "not attributable", which covers both a non-git directory
	 * and an emitter older than ecosystem 0.71.0. No sentinel distinguishes
	 * them, because every consumer handles them identically and the second case
	 * ages out.
	 *
	 * Still envelope, not payload - the safety story above is unchanged.
	 */
	project?: string;
	/**
	 * Which derivation produced `project`. `remote` (from the origin URL) is
	 * portable across machines; `root` (from the repo path) is machine-local,
	 * so the same remote-less repo on a laptop and a desktop yields two
	 * different keys. A consumer aggregating per repository must treat the two
	 * differently rather than summing them.
	 */
	project_basis?: "remote" | "root";
}

/** One repository's share of a session, as `counts_by_project` records it. */
export interface ProjectCount {
	basis: "remote" | "root";
	event_count: number;
}

export interface SessionSummary {
	session_id: string;
	machine_id: string | null;
	started_at: string;
	/** Null while the session is still running - no `session.end` seen yet. */
	ended_at: string | null;
	event_count: number;
	/** Keyed by the part of `event_type` before the first dot. */
	counts_by_prefix: Record<string, number>;
	/**
	 * Keyed by the full `event_type` (ONL-128).
	 *
	 * The prefix alone cannot tell a plugin doing its job from one running and
	 * producing nothing: `curator: 15027` was 8,225 scans started, 6,802
	 * completed, and zero findings, ever. The type is what says which.
	 *
	 * Still envelope, not payload - a type names what happened, never to what -
	 * but only while it is a registered name, and this fold does not have the
	 * schema's list. So a type is keyed only when it matches EVENT_TYPE_PATTERN,
	 * and only the first MAX_TYPES_PER_SESSION of them. An event left out of
	 * the map is still in `event_count` and `counts_by_prefix`, so the counts
	 * here sum to those only when every type was well-shaped.
	 */
	counts_by_type: Record<string, number>;
	/**
	 * Keyed by project key, for the events of this session that carried one.
	 *
	 * A map rather than a scalar because sessions genuinely span repositories:
	 * measured against lineage's ledger, 20 of 115 sessions (17.4%) touched
	 * more than one project and one touched three. A first-seen or modal column
	 * would be silently wrong for a sixth of sessions in exactly the "which
	 * repo burns the most" number this exists to produce.
	 *
	 * Empty when no event was attributable - never null, so a consumer has one
	 * kind of nothing to handle. Its counts sum to `event_count` only when
	 * every event carried a key, which is not true of a session that spans the
	 * ecosystem 0.71.0 upgrade.
	 */
	counts_by_project: Record<string, ProjectCount>;
	plugins: string[];
	prompts: number;
	compactions: number;
}

/**
 * Twenty events.
 *
 * Measured rather than chosen: over an 80,000-event sample of one machine's
 * log there were 11,186 session ids with a median length of three - a start, an
 * end, and one plugin event, having done nothing - and only 72 sessions above
 * twenty. Those 72 held more events than the other 11,114 combined.
 *
 * Exported and overridable because it is an observation about ONE log, and a
 * constant nobody can move would harden that into a rule for everybody.
 */
export const DEFAULT_THRESHOLD = 20;

/**
 * What a registered event type looks like: lowercase dotted segments, at
 * least two of them, at most 64 characters in all.
 *
 * Every one of the 85 types in a 168MB log matched it, the longest at 30
 * characters (measured 2026-10-24). Anything else is a writer that did not go
 * through the schema, and its type is not keyed - see `counts_by_type`.
 *
 * The API holds stored keys to the same pattern; scripts/source-guards.test.sh
 * keeps the two identical.
 */
export const EVENT_TYPE_PATTERN =
	/^(?=.{1,64}$)[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

/**
 * A hundred and twenty-eight distinct types per session.
 *
 * Three times the busiest session measured (41 distinct types, 37,618
 * sessions, 2026-10-24). It bounds a writer that mints a fresh type per event,
 * which would otherwise make one summary bigger than the API takes in a
 * request. Types already keyed keep counting past it.
 */
export const MAX_TYPES_PER_SESSION = 128;

/** The part of an event type before the first dot, per eventlog.ts. */
function prefixOf(eventType: string): string {
	const dot = eventType.indexOf(".");
	return dot === -1 ? eventType : eventType.slice(0, dot);
}

interface Accumulator {
	machine_id: string | null;
	started_at: string;
	ended_at: string | null;
	last_at: string;
	event_count: number;
	counts_by_prefix: Record<string, number>;
	counts_by_type: Record<string, number>;
	type_count: number;
	counts_by_project: Record<string, ProjectCount>;
	plugins: Set<string>;
	prompts: number;
	compactions: number;
}

/**
 * Fold events into one summary per session worth showing.
 *
 * Accepts a sync OR async iterable, and is itself async so a caller can hand
 * it a streamed source without materializing it first. The fold was already
 * incremental - one small accumulator per session, never the whole event
 * list - so letting iteration itself be async is what lets that
 * incrementality reach all the way back to the file read: eventlog.ts's
 * `readEventEnvelopes` yields one envelope at a time from a ~90MB-and-growing
 * log, and a caller that collected them into an array before calling this
 * function would have defeated the entire point of streaming the read.
 *
 * `threshold` drops sessions too small to be worth a row. `since` bounds the
 * report to sessions whose last event is recent, so a machine that has not
 * synced in a while still reports its recent work.
 *
 * Insertion-ordered by first appearance, which for an append-only log means
 * oldest session first. The caller sorts if it wants something else.
 */
export async function summarizeSessions(
	events: Iterable<EventEnvelope> | AsyncIterable<EventEnvelope>,
	opts: { threshold?: number; since?: string } = {},
): Promise<SessionSummary[]> {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const sessions = new Map<string, Accumulator>();

	for await (const event of events) {
		// A line missing either of these cannot be attributed to a session or
		// placed in time, and one bad writer must not stop the pass.
		if (!event.session_id || !event.timestamp) continue;

		let acc = sessions.get(event.session_id);
		if (!acc) {
			acc = {
				machine_id: event.machine_id ?? null,
				started_at: event.timestamp,
				ended_at: null,
				last_at: event.timestamp,
				event_count: 0,
				// `Object.create(null)`, not `{}`: an `event_type` prefix of
				// `__proto__` or `constructor` on a plain object literal reads back
				// through `Object.prototype` instead of returning `undefined`, and an
				// assignment through it pollutes every object in the process for the
				// life of the CLI invocation. See eventlog.ts:179-185 for the same guard.
				counts_by_prefix: Object.create(null),
				// Same guard: `constructor.trap` is a well-shaped type.
				counts_by_type: Object.create(null),
				type_count: 0,
				// `Object.create(null)` for the same reason as the line above,
				// and the reason applies just as literally here: this fold does
				// not validate the envelope's `^[0-9a-f]{12}$` pattern, it keys
				// on whatever the log said, so a line claiming a `__proto__`
				// project is the same hazard as a `__proto__` event prefix.
				counts_by_project: Object.create(null),
				plugins: new Set(),
				prompts: 0,
				compactions: 0,
			};
			sessions.set(event.session_id, acc);
		}

		acc.event_count += 1;
		if (event.timestamp < acc.started_at) acc.started_at = event.timestamp;
		if (event.timestamp > acc.last_at) acc.last_at = event.timestamp;

		const prefix = prefixOf(event.event_type);
		acc.counts_by_prefix[prefix] = (acc.counts_by_prefix[prefix] ?? 0) + 1;

		const typeCount = acc.counts_by_type[event.event_type];
		if (typeCount !== undefined) {
			acc.counts_by_type[event.event_type] = typeCount + 1;
		} else if (
			acc.type_count < MAX_TYPES_PER_SESSION &&
			EVENT_TYPE_PATTERN.test(event.event_type)
		) {
			acc.counts_by_type[event.event_type] = 1;
			acc.type_count += 1;
		}

		if (event.plugin) acc.plugins.add(event.plugin);

		// Both fields or neither, matching what the emitter will send: a key
		// without its basis is not attributable, because nothing here could
		// tell a portable remote-derived key from a machine-local one, and
		// inventing a basis is what would make two machines' rows for one repo
		// look like two repos.
		if (event.project && event.project_basis) {
			const existing = acc.counts_by_project[event.project];
			if (existing) existing.event_count += 1;
			else {
				acc.counts_by_project[event.project] = {
					basis: event.project_basis,
					event_count: 1,
				};
			}
		}

		if (event.event_type === "session.end") acc.ended_at = event.timestamp;
		else if (event.event_type === "session.prompt") acc.prompts += 1;
		else if (event.event_type === "session.compact") acc.compactions += 1;
	}

	const summaries: SessionSummary[] = [];
	for (const [session_id, acc] of sessions) {
		if (acc.event_count < threshold) continue;
		if (opts.since && acc.last_at < opts.since) continue;

		summaries.push({
			session_id,
			machine_id: acc.machine_id,
			started_at: acc.started_at,
			ended_at: acc.ended_at,
			event_count: acc.event_count,
			counts_by_prefix: acc.counts_by_prefix,
			counts_by_type: acc.counts_by_type,
			counts_by_project: acc.counts_by_project,
			plugins: [...acc.plugins].sort(),
			prompts: acc.prompts,
			compactions: acc.compactions,
		});
	}
	return summaries;
}
