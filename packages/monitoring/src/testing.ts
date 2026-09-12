import type {
	Attributes,
	CaptureContext,
	Level,
	Monitor,
	MonitorUser,
	SpanOptions,
} from "./monitor";

/**
 * A monitor that writes down everything it is told.
 *
 * Lifted from the fake sink in apps/website's waitlist tests, so every app
 * asserts what it reported the same way instead of each growing its own.
 */
export function createRecordingMonitor() {
	const exceptions: { error: unknown; context?: CaptureContext }[] = [];
	const messages: {
		message: string;
		level?: Level;
		context?: CaptureContext;
	}[] = [];
	const users: (MonitorUser | null)[] = [];
	const counts: { name: string; value?: number; attributes?: Attributes }[] =
		[];
	const logs: { level: Level; message: string; attributes?: Attributes }[] = [];
	const spans: SpanOptions[] = [];
	let flushes = 0;

	const monitor: Monitor = {
		captureException(error, context) {
			exceptions.push({ error, context });
		},
		captureMessage(message, level, context) {
			messages.push({ message, level, context });
		},
		setUser(user) {
			users.push(user);
		},
		count(name, value, attributes) {
			counts.push({ name, value, attributes });
		},
		log(level, message, attributes) {
			logs.push({ level, message, attributes });
		},
		startSpan(options, fn) {
			spans.push(options);
			return fn();
		},
		flush() {
			flushes += 1;
			return Promise.resolve(true);
		},
	};

	return {
		monitor,
		exceptions,
		messages,
		users,
		counts,
		logs,
		spans,
		get flushes() {
			return flushes;
		},
	};
}

export type RecordingMonitor = ReturnType<typeof createRecordingMonitor>;
