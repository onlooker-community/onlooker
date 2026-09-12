import { describe, expect, it } from "vitest";
import { fanout, guarded, type Monitor, noopMonitor } from "./monitor";
import { createRecordingMonitor } from "./testing";

function throwingMonitor(): Monitor {
	const boom = () => {
		throw new Error("monitor broke");
	};
	return {
		captureException: boom,
		captureMessage: boom,
		setUser: boom,
		count: boom,
		log: boom,
		startSpan: boom,
		flush: boom,
	};
}

describe("noopMonitor", () => {
	it("still runs the span's work", () => {
		expect(noopMonitor.startSpan({ name: "s", op: "o" }, () => 7)).toBe(7);
	});
});

describe("guarded", () => {
	it("swallows every throw from a broken monitor", async () => {
		const monitor = guarded(throwingMonitor());

		expect(() => monitor.captureException(new Error("x"))).not.toThrow();
		expect(() => monitor.captureMessage("x")).not.toThrow();
		expect(() => monitor.setUser({ id: "u1" })).not.toThrow();
		expect(() => monitor.count("x")).not.toThrow();
		expect(() => monitor.log("info", "x")).not.toThrow();
		await expect(monitor.flush()).resolves.toBe(false);
	});

	it("runs the work anyway when the monitor fails before starting the span", () => {
		const monitor = guarded(throwingMonitor());
		let runs = 0;

		const result = monitor.startSpan({ name: "s", op: "o" }, () => {
			runs += 1;
			return "done";
		});

		expect(result).toBe("done");
		expect(runs).toBe(1);
	});

	it("returns the value when the monitor fails after the work finished", () => {
		const monitor = guarded({
			...noopMonitor,
			startSpan(_options, fn) {
				fn();
				throw new Error("span close broke");
			},
		});
		let runs = 0;

		const result = monitor.startSpan({ name: "s", op: "o" }, () => {
			runs += 1;
			return "done";
		});

		expect(result).toBe("done");
		expect(runs).toBe(1);
	});

	it("propagates the work's own error", () => {
		const monitor = guarded(noopMonitor);
		const failure = new Error("the work failed");

		expect(() =>
			monitor.startSpan({ name: "s", op: "o" }, () => {
				throw failure;
			}),
		).toThrow(failure);
	});
});

describe("fanout", () => {
	it("tells every monitor, even past one that throws", () => {
		const first = createRecordingMonitor();
		const last = createRecordingMonitor();
		const monitor = fanout(first.monitor, throwingMonitor(), last.monitor);
		const error = new Error("x");

		monitor.captureException(error, { tags: { surface: "test" } });
		monitor.setUser({ id: "u1" });
		monitor.count("thing.happened", 2, { ok: true });

		for (const recorder of [first, last]) {
			expect(recorder.exceptions).toEqual([
				{ error, context: { tags: { surface: "test" } } },
			]);
			expect(recorder.users).toEqual([{ id: "u1" }]);
			expect(recorder.counts).toEqual([
				{ name: "thing.happened", value: 2, attributes: { ok: true } },
			]);
		}
	});

	it("opens a span in every monitor and runs the work once", async () => {
		const a = createRecordingMonitor();
		const b = createRecordingMonitor();
		const monitor = fanout(a.monitor, b.monitor);
		let runs = 0;

		const result = await monitor.startSpan(
			{ name: "submit", op: "http.client" },
			async () => {
				runs += 1;
				return "ok";
			},
		);

		expect(result).toBe("ok");
		expect(runs).toBe(1);
		expect(a.spans.map((s) => s.name)).toEqual(["submit"]);
		expect(b.spans.map((s) => s.name)).toEqual(["submit"]);
	});

	it("reports drained only when every monitor drained", async () => {
		const ok = createRecordingMonitor();

		await expect(fanout(ok.monitor, noopMonitor).flush()).resolves.toBe(true);
		await expect(fanout(ok.monitor, throwingMonitor()).flush()).resolves.toBe(
			false,
		);
		expect(ok.flushes).toBe(2);
	});
});
