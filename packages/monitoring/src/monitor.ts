export type Level = "debug" | "info" | "warn" | "error";

/** Values a provider can index and filter on. Nothing nested, nothing opaque. */
export type Attributes = Record<string, string | number | boolean>;

export interface CaptureContext {
	/** Indexed and filterable - `surface`, `kind`. Keep the value set small. */
	tags?: Record<string, string>;
	/** Attached for reading, not for filtering. */
	extra?: Record<string, unknown>;
}

/**
 * Who an event happened to. An id, and on purpose nothing else.
 *
 * The email is on hand in every app that has a user and is the obvious thing to
 * attach. It is also the one field that turns an error report into personal
 * data sitting in a third party's store. The id is enough to find the account
 * from our side, and useless to anyone else.
 */
export interface MonitorUser {
	id: string;
}

export interface SpanOptions {
	name: string;
	op: string;
	attributes?: Attributes;
}

/**
 * Everything an app may say about itself.
 *
 * Generalized from the waitlist's `WaitlistSink`
 * (apps/website/src/lib/waitlist-telemetry.ts), which was already this shape
 * for the same two reasons: a state machine can be tested against a fake, and a
 * missing SDK cannot throw from a form handler.
 *
 * No method may throw. These run inside an error boundary that has already
 * caught something, or a request handler already failing; a monitor that
 * throws there is a second failure on top of the first. Implementations are
 * expected to hold to that, and `guarded` enforces it for those that do not.
 */
export interface Monitor {
	captureException(error: unknown, context?: CaptureContext): void;
	captureMessage(
		message: string,
		level?: Level,
		context?: CaptureContext,
	): void;
	setUser(user: MonitorUser | null): void;
	count(name: string, value?: number, attributes?: Attributes): void;
	log(level: Level, message: string, attributes?: Attributes): void;
	/**
	 * Runs `fn` inside a span and returns what it returns. The one method that
	 * can throw - but only `fn`'s own error, never the monitor's.
	 */
	startSpan<T>(options: SpanOptions, fn: () => T): T;
	/** Resolves false rather than rejecting when the buffer did not drain. */
	flush(timeoutMs?: number): Promise<boolean>;
}

/** Says nothing. For tests, and for an app whose monitoring is not configured. */
export const noopMonitor: Monitor = {
	captureException() {},
	captureMessage() {},
	setUser() {},
	count() {},
	log() {},
	startSpan(_options, fn) {
		return fn();
	},
	flush() {
		return Promise.resolve(true);
	},
};

function quietly(call: () => void): void {
	try {
		call();
	} catch {
		// Swallowed on purpose - see the contract on `Monitor`. There is nowhere
		// left to report a failure to report.
	}
}

/**
 * Hold a monitor to the no-throw contract whether or not it keeps it.
 *
 * `startSpan` is the delicate one. If the monitor fails before `fn` runs, `fn`
 * still has to run - the caller's work must not be skipped because tracing
 * broke. If the monitor fails after `fn` returned, the value still comes back.
 * Only when `fn` itself threw does anything propagate.
 */
export function guarded(monitor: Monitor): Monitor {
	return {
		captureException: (error, context) =>
			quietly(() => monitor.captureException(error, context)),
		captureMessage: (message, level, context) =>
			quietly(() => monitor.captureMessage(message, level, context)),
		setUser: (user) => quietly(() => monitor.setUser(user)),
		count: (name, value, attributes) =>
			quietly(() => monitor.count(name, value, attributes)),
		log: (level, message, attributes) =>
			quietly(() => monitor.log(level, message, attributes)),
		startSpan<T>(options: SpanOptions, fn: () => T): T {
			let called = false;
			let finished = false;
			let value: T | undefined;
			try {
				return monitor.startSpan(options, () => {
					called = true;
					value = fn();
					finished = true;
					return value;
				});
			} catch (error) {
				if (!called) return fn();
				if (finished) return value as T;
				throw error;
			}
		},
		async flush(timeoutMs) {
			try {
				return await monitor.flush(timeoutMs);
			} catch {
				return false;
			}
		},
	};
}

/**
 * Say the same thing to several monitors.
 *
 * Exists for the move between destinations. apps/web reports to Workers Logs
 * today and an hourly workflow alerts on it; sending to a new provider instead
 * of that would leave the workflow green and blind. Fanning out keeps both fed
 * until the old one is retired on purpose.
 *
 * Each monitor is guarded, so one that throws cannot starve the rest.
 */
export function fanout(...monitors: Monitor[]): Monitor {
	const all = monitors.map(guarded);

	return {
		captureException: (error, context) => {
			for (const m of all) m.captureException(error, context);
		},
		captureMessage: (message, level, context) => {
			for (const m of all) m.captureMessage(message, level, context);
		},
		setUser: (user) => {
			for (const m of all) m.setUser(user);
		},
		count: (name, value, attributes) => {
			for (const m of all) m.count(name, value, attributes);
		},
		log: (level, message, attributes) => {
			for (const m of all) m.log(level, message, attributes);
		},
		// Nested, outermost first, so `fn` runs exactly once inside every span.
		startSpan<T>(options: SpanOptions, fn: () => T): T {
			const run = all.reduceRight<() => T>(
				(inner, m) => () => m.startSpan(options, inner),
				fn,
			);
			return run();
		},
		async flush(timeoutMs) {
			const drained = await Promise.all(all.map((m) => m.flush(timeoutMs)));
			return drained.every(Boolean);
		},
	};
}
