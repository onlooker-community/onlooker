import { noopMonitor } from "@onlooker/monitoring";
import { describe, expect, it, vi } from "vitest";
import { createNodeMonitor, type FetchLike } from "./node";

const DSN = "https://public@o1.ingest.sentry.io/1";
const HOME = "/Users/alice";

function fakeFetch() {
	return vi.fn<FetchLike>(async () => ({
		status: 200,
		headers: { get: () => null },
	}));
}

/** The event item from the one envelope `fetch` was handed. */
// biome-ignore lint/suspicious/noExplicitAny: a parsed Sentry envelope, asserted field by field
function sentEvent(fetch: ReturnType<typeof fakeFetch>): Record<string, any> {
	expect(fetch).toHaveBeenCalledTimes(1);
	const body = fetch.mock.calls[0]?.[1].body;
	// An envelope with no attachments serializes to a string.
	expect(typeof body).toBe("string");
	const lines = (body as string).split("\n");
	const at = lines.findIndex((line) => {
		try {
			return JSON.parse(line).type === "event";
		} catch {
			return false;
		}
	});
	return JSON.parse(lines[at + 1] as string);
}

async function capture(error: unknown, tags?: Record<string, string>) {
	const fetch = fakeFetch();
	const monitor = createNodeMonitor(
		{ dsn: DSN, environment: "production", release: "onlooker-cli@9.9.9" },
		{ fetch, home: HOME },
	);
	monitor.captureException(error, tags ? { tags } : undefined);
	expect(await monitor.flush(2000)).toBe(true);
	return sentEvent(fetch);
}

describe("createNodeMonitor", () => {
	it("is the no-op monitor when no DSN is configured, and builds no client", () => {
		const fetch = fakeFetch();
		const monitor = createNodeMonitor(
			{ dsn: undefined, environment: "production" },
			{ fetch, home: HOME },
		);
		expect(monitor).toBe(noopMonitor);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("files the event under the release and environment it was given", async () => {
		const event = await capture(new TypeError("boom"));
		expect(event.release).toBe("onlooker-cli@9.9.9");
		expect(event.environment).toBe("production");
		expect(event.exception.values[0].type).toBe("TypeError");
	});

	// The two things a person's machine adds that the hosted apps never had.
	it("shows the home directory as ~ and frame paths as file names", async () => {
		const event = await capture(new Error(`${HOME}/.onlooker/cli.json broke`));
		const exception = event.exception.values[0];
		expect(exception.value).toBe("~/.onlooker/cli.json broke");
		const frames = exception.stacktrace.frames as Array<
			Record<string, unknown>
		>;
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(String(frame.filename)).not.toContain("/");
			expect(frame.abs_path).toBeUndefined();
			expect(frame.module).toBeUndefined();
		}
	});

	it("carries no host, no user and no tags it was not given", async () => {
		const tags = { command: "sync", os: "darwin", arch: "arm64", node: "22" };
		const event = await capture(new Error("x"), tags);
		expect(event.server_name).toBeUndefined();
		expect(event.user).toBeUndefined();
		expect(event.tags).toEqual(tags);
	});

	it("redacts anything credential-shaped in the message", async () => {
		const hex = "0123456789abcdef".repeat(3);
		const event = await capture(new Error(`failed ?token=${hex}`));
		expect(JSON.stringify(event)).not.toContain(hex);
	});

	// linkedErrors: a wrapped error arrives with the one it wraps.
	it("keeps the cause chain", async () => {
		const event = await capture(
			new Error("outer", { cause: new RangeError("inner") }),
		);
		const types = event.exception.values.map((v: { type: string }) => v.type);
		expect(types).toEqual(expect.arrayContaining(["Error", "RangeError"]));
	});
});
