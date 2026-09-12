import { describe, expect, it } from "vitest";
import {
	createWaitlistTelemetry,
	WAITLIST_METRICS,
	type WaitlistSink,
} from "../lib/waitlist-telemetry";

function fakeSink() {
	const counts: { name: string; attributes?: { looks_valid: boolean } }[] = [];
	const logs: string[] = [];
	const exceptions: unknown[] = [];
	const spans: string[] = [];
	let flushes = 0;

	const sink: WaitlistSink = {
		count(name, _value, options) {
			counts.push({ name, attributes: options?.attributes });
		},
		log(message) {
			logs.push(message);
		},
		captureException(error) {
			exceptions.push(error);
		},
		async startSpan(options, fn) {
			spans.push(options.name);
			return fn();
		},
		flush() {
			flushes += 1;
			return Promise.resolve();
		},
	};

	return {
		sink,
		counts,
		logs,
		exceptions,
		spans,
		get flushes() {
			return flushes;
		},
	};
}

describe("waitlist telemetry", () => {
	it("records viewed once", () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);

		telemetry.viewed();
		telemetry.viewed();

		expect(fake.counts.map((c) => c.name)).toEqual([WAITLIST_METRICS.viewed]);
		expect(fake.logs).toEqual([WAITLIST_METRICS.viewed]);
	});

	it("starts on the first non-empty input and ignores later keystrokes", () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);

		telemetry.onEmailInput(false, false);
		telemetry.onEmailInput(true, false);
		telemetry.onEmailInput(true, true);

		expect(fake.counts).toEqual([
			{
				name: WAITLIST_METRICS.emailStarted,
				attributes: { looks_valid: false },
			},
		]);
	});

	it("counts abandoned after typing without submit", () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);

		telemetry.onEmailInput(true, true);
		telemetry.maybeAbandon();
		telemetry.maybeAbandon();
		telemetry.flush();

		expect(fake.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.abandoned,
		]);
		expect(fake.counts[1]?.attributes).toEqual({ looks_valid: true });
		expect(fake.flushes).toBe(1);
	});

	it("does not count abandoned after submit", () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);

		telemetry.onEmailInput(true, true);
		telemetry.onSubmit(true);
		telemetry.maybeAbandon();

		expect(fake.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.submitted,
		]);
	});

	it("wraps submit in a span and records success without capturing", async () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);

		telemetry.onSubmit(true);
		const result = await telemetry.submitWithSpan(async () => "ok");
		telemetry.onSubmitSucceeded(true);

		expect(result).toBe("ok");
		expect(fake.spans).toEqual(["waitlist.submit"]);
		expect(fake.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.submitted,
			WAITLIST_METRICS.submitSucceeded,
		]);
		expect(fake.exceptions).toEqual([]);
	});

	it("captures the error on submit failure and still does not abandon", async () => {
		const fake = fakeSink();
		const telemetry = createWaitlistTelemetry(fake.sink);
		const failure = new Error("non-ok response");

		telemetry.onEmailInput(true, true);
		telemetry.onSubmit(true);
		await telemetry
			.submitWithSpan(async () => {
				throw failure;
			})
			.catch((err: unknown) => {
				telemetry.onSubmitFailed(err, true);
			});
		telemetry.maybeAbandon();

		expect(fake.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.submitted,
			WAITLIST_METRICS.submitFailed,
		]);
		expect(fake.exceptions).toEqual([failure]);
	});
});
