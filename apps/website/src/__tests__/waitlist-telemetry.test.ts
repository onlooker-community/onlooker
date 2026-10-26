import { createRecordingMonitor } from "@onlooker/monitoring/testing";
import { describe, expect, it } from "vitest";
import {
	createWaitlistTelemetry,
	WAITLIST_METRICS,
} from "../lib/waitlist-telemetry";

describe("waitlist telemetry", () => {
	it("records viewed once", () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);

		telemetry.viewed();
		telemetry.viewed();

		expect(recording.counts).toEqual([
			{ name: WAITLIST_METRICS.viewed, value: 1, attributes: undefined },
		]);
		expect(recording.logs).toEqual([
			{
				level: "info",
				message: WAITLIST_METRICS.viewed,
				attributes: undefined,
			},
		]);
	});

	it("starts on the first non-empty input and ignores later keystrokes", () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);

		telemetry.onEmailInput(false, false);
		telemetry.onEmailInput(true, false);
		telemetry.onEmailInput(true, true);

		expect(recording.counts).toEqual([
			{
				name: WAITLIST_METRICS.emailStarted,
				value: 1,
				attributes: { looks_valid: false },
			},
		]);
	});

	it("counts abandoned after typing without submit", () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);

		telemetry.onEmailInput(true, true);
		telemetry.maybeAbandon();
		telemetry.maybeAbandon();
		telemetry.flush();

		expect(recording.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.abandoned,
		]);
		expect(recording.counts[1]?.attributes).toEqual({ looks_valid: true });
		expect(recording.flushes).toBe(1);
	});

	it("does not count abandoned after submit", () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);

		telemetry.onEmailInput(true, true);
		telemetry.onSubmit(true);
		telemetry.maybeAbandon();

		expect(recording.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.submitted,
		]);
	});

	it("wraps submit in a span and records success without capturing", async () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);

		telemetry.onSubmit(true);
		const result = await telemetry.submitWithSpan(async () => "ok");
		telemetry.onSubmitSucceeded(true);

		expect(result).toBe("ok");
		expect(recording.spans).toEqual([
			{ name: "waitlist.submit", op: "http.client" },
		]);
		expect(recording.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.submitted,
			WAITLIST_METRICS.submitSucceeded,
		]);
		expect(recording.exceptions).toEqual([]);
	});

	it("captures the error on submit failure and still does not abandon", async () => {
		const recording = createRecordingMonitor();
		const telemetry = createWaitlistTelemetry(recording.monitor);
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

		expect(recording.counts.map((c) => c.name)).toEqual([
			WAITLIST_METRICS.emailStarted,
			WAITLIST_METRICS.submitted,
			WAITLIST_METRICS.submitFailed,
		]);
		// Tagged, so the waitlist's failures can be filtered apart from the
		// rest of the site's. The sink this replaced tagged them the same way.
		expect(recording.exceptions).toEqual([
			{ error: failure, context: { tags: { surface: "waitlist" } } },
		]);
	});
});
