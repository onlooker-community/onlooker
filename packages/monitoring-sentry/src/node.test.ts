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

/** The whole envelope, headers included: what actually leaves the machine. */
function sentEnvelope(fetch: ReturnType<typeof fakeFetch>): string {
	expect(fetch).toHaveBeenCalledTimes(1);
	return fetch.mock.calls[0]?.[1].body as string;
}

function monitorFor(fetch: FetchLike, home = HOME) {
	return createNodeMonitor(
		{ dsn: DSN, environment: "production", release: "onlooker-cli@9.9.9" },
		{ fetch, home },
	);
}

async function capture(error: unknown, tags?: Record<string, string>) {
	const fetch = fakeFetch();
	const monitor = monitorFor(fetch);
	monitor.captureException(error, tags ? { tags } : undefined);
	expect(await monitor.flush(2000)).toBe(true);
	return sentEvent(fetch);
}

/** Capture one error and return the serialized envelope it produced. */
async function envelopeFor(error: unknown, home = HOME) {
	const fetch = fakeFetch();
	const monitor = monitorFor(fetch, home);
	monitor.captureException(error);
	expect(await monitor.flush(2000)).toBe(true);
	return { body: sentEnvelope(fetch), event: sentEvent(fetch) };
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
		const event = await capture(new Error(`${HOME} broke`));
		const exception = event.exception.values[0];
		expect(exception.value).toBe("~ broke");
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

// The spec's table is an allowlist, so the adapter builds the event from the
// fields it names. Anything a caller, the scope or the SDK attaches beyond
// them is dropped rather than scrubbed: a scrub only catches what it knows
// the shape of.
describe("createNodeMonitor, the allowlist", () => {
	it("sends nothing of a thrown plain object but its keys", async () => {
		const opaque = ["q8Zr", "Lm2x", "Vt9w"].join("-");
		const { body, event } = await envelopeFor({
			response: `${HOME}/clients/acme/out.json`,
			token: opaque,
		});
		expect(body).not.toContain(HOME);
		expect(body).not.toContain("acme");
		expect(body).not.toContain(opaque);
		expect(event).not.toHaveProperty("extra");
	});

	it("drops extra, user and breadcrumbs however they were attached", async () => {
		const fetch = fakeFetch();
		const monitor = monitorFor(fetch);
		const email = ["someone", "example.com"].join("@");
		monitor.setUser({ id: "user-1234" });
		monitor.captureException(new Error("x"), {
			extra: { cwd: `${HOME}/clients/acme`, email },
		});
		expect(await monitor.flush(2000)).toBe(true);
		const body = sentEnvelope(fetch);
		expect(body).not.toContain("acme");
		expect(body).not.toContain(email);
		expect(body).not.toContain("user-1234");
		const event = sentEvent(fetch);
		for (const key of ["extra", "user", "breadcrumbs", "request", "modules"]) {
			expect(event).not.toHaveProperty(key);
		}
	});
});

// A parse error's message can quote the text it failed on, which on a crash
// over a corrupt local file is that file's contents.
describe("createNodeMonitor, parse errors", () => {
	const OMITTED = "[message omitted: may quote input]";
	// Node quotes only the first ten characters or so of what it failed on.
	const marker = "zqmark771";

	function parseFailure(): unknown {
		try {
			JSON.parse(marker);
		} catch (error) {
			return error;
		}
		throw new Error("JSON.parse accepted the input");
	}

	it("leaves out what a JSON.parse failure quotes, keeping type and frames", async () => {
		const error = parseFailure();
		// The premise: Node's message does quote the input.
		expect((error as Error).message).toContain(marker);
		const { body, event } = await envelopeFor(error);
		expect(body).not.toContain(marker);
		const [top] = event.exception.values;
		expect(top.type).toBe("SyntaxError");
		expect(top.value).toBe(OMITTED);
		expect(top.stacktrace.frames.length).toBeGreaterThan(0);
	});

	it("does the same for a SyntaxError wrapped as a cause", async () => {
		const { body, event } = await envelopeFor(
			new Error("could not read config", { cause: parseFailure() }),
		);
		expect(body).not.toContain(marker);
		const values = event.exception.values as Array<{
			type: string;
			value: string;
		}>;
		expect(values.find((v) => v.type === "SyntaxError")?.value).toBe(OMITTED);
		expect(values.find((v) => v.type === "Error")?.value).toBe(
			"could not read config",
		);
	});

	it("does the same for a SyntaxError that arrives as a message", async () => {
		const fetch = fakeFetch();
		const monitor = monitorFor(fetch);
		monitor.captureMessage(`SyntaxError: Unexpected token ${marker}`);
		expect(await monitor.flush(2000)).toBe(true);
		expect(sentEnvelope(fetch)).not.toContain(marker);
		expect(sentEvent(fetch).message).toBe(OMITTED);
	});
});

// A frame path is cut to its file name; the same must hold for a path a
// message carries, wherever the CLI was run from, or `crash-reports on`
// promises more than it delivers.
describe("createNodeMonitor, paths and addresses in text", () => {
	const email = ["someone", "example.com"].join("@");
	const cases: Array<[string, string, string]> = [
		["a path outside home", "/Volumes/Work/repo/a.ts", "a.ts"],
		["a path under home", `${HOME}/clients/acme/repo/x.json`, "x.json"],
		["a temp path", "/private/tmp/onlooker-abc/b.json", "b.json"],
		["a Windows path", "C:\\Users\\bob\\proj\\c.ts", "c.ts"],
		["a file URL", "file:///Volumes/Work/repo/d.mjs", "d.mjs"],
	];

	for (const [what, path, file] of cases) {
		it(`cuts ${what} in the message to its file name`, async () => {
			const { body, event } = await envelopeFor(
				new Error(`could not parse ${path} at line 3`),
			);
			expect(event.exception.values[0].value).toBe(
				`could not parse ${file} at line 3`,
			);
			expect(body).not.toContain(path.slice(0, path.lastIndexOf(file)));
		});
	}

	it("keeps a quoted path with spaces whole until the cut", async () => {
		const { event } = await envelopeFor(
			new Error("open '/Volumes/My Drive/repo/e.json' failed"),
		);
		expect(event.exception.values[0].value).toBe("open 'e.json' failed");
	});

	it("leaves URLs and module specifiers alone", async () => {
		const { event } = await envelopeFor(
			new Error("GET https://api.onlooker.dev/v1/sync from node:fs"),
		);
		expect(event.exception.values[0].value).toBe(
			"GET https://api.onlooker.dev/v1/sync from node:fs",
		);
	});

	it("redacts an email address", async () => {
		const { body } = await envelopeFor(new Error(`no account for ${email}`));
		expect(body).not.toContain(email);
		expect(body).not.toContain("someone");
	});

	it("gives a wrapped error's value the same treatment", async () => {
		const { body, event } = await envelopeFor(
			new Error("outer", {
				cause: new Error(`read /Volumes/Work/repo/f.ts for ${email}`),
			}),
		);
		expect(body).not.toContain("/Volumes");
		expect(body).not.toContain(email);
		const values = event.exception.values.map(
			(v: { value: string }) => v.value,
		);
		expect(values.some((v: string) => v.startsWith("read f.ts for "))).toBe(
			true,
		);
	});

	it("cuts a path under a Windows home to its file name", async () => {
		const home = "C:\\Users\\alice";
		const { body, event } = await envelopeFor(
			new Error(`read ${home}\\work\\acme\\c.ts failed`),
			home,
		);
		expect(event.exception.values[0].value).toBe("read c.ts failed");
		expect(body).not.toContain("acme");
	});

	it("cuts a path that follows a colon, but not the slashes of a URL", async () => {
		const { body, event } = await envelopeFor(
			new Error("path:/Volumes/Work/acme/x.ts via https://api.onlooker.dev/v1"),
		);
		expect(event.exception.values[0].value).toBe(
			"path:x.ts via https://api.onlooker.dev/v1",
		);
		expect(body).not.toContain("acme");
	});

	it("replaces home only at a path boundary", async () => {
		const { event } = await envelopeFor(
			new Error(`see ${HOME}bob/x and ${HOME}/y.ts`),
		);
		const value = event.exception.values[0].value as string;
		expect(value).not.toContain("~bob");
		expect(value).toContain("y.ts");
		expect(value).not.toContain(`${HOME}/`);
	});

	// A home of `/` would otherwise turn every slash in a message into `~`.
	it("does not treat a root home directory as a prefix", async () => {
		const { event } = await envelopeFor(new Error("either/or"), "/");
		expect(event.exception.values[0].value).toBe("either/or");
	});
});

// `run()` prints "reported this crash" only when flush says true, so true
// must mean the event was accepted, not merely that the request settled.
describe("createNodeMonitor, delivery", () => {
	it("says not sent when the server answers with an error status", async () => {
		const fetch = vi.fn<FetchLike>(async () => ({
			status: 500,
			headers: { get: () => null },
		}));
		const monitor = monitorFor(fetch);
		monitor.captureException(new Error("x"));
		expect(await monitor.flush(2000)).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("says not sent when the request fails", async () => {
		const fetch = vi.fn<FetchLike>(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		const monitor = monitorFor(fetch);
		monitor.captureException(new Error("x"));
		expect(await monitor.flush(2000)).toBe(false);
	});

	// flush(2000) stops waiting but cannot close a request; only an abort does,
	// and until it closes the process cannot exit.
	it("aborts a send that never answers, and says not sent", async () => {
		let signal: AbortSignal | undefined;
		const fetch = vi.fn<FetchLike>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					signal = init.signal;
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const monitor = monitorFor(fetch);
		monitor.captureException(new Error("x"));
		const started = Date.now();
		expect(await monitor.flush(2000)).toBe(false);
		await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
			timeout: 500,
		});
		expect(Date.now() - started).toBeLessThan(2600);
	});
});
