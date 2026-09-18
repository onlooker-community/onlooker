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
		if (event.plugin) acc.plugins.add(event.plugin);

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
			plugins: [...acc.plugins].sort(),
			prompts: acc.prompts,
			compactions: acc.compactions,
		});
	}
	return summaries;
}
