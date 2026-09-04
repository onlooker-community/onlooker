import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Failure } from "../api";
import { run } from "../cli";
import { doctor } from "../commands/doctor";
import { sync } from "../commands/sync";

// Wraps the real `sync` rather than replacing it, so the last test in this file
// can exercise the genuine wiring while the rest inject the failure they need.
vi.mock("../commands/sync", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../commands/sync")>();
	return { sync: vi.fn(actual.sync) };
});

// Mocked rather than wrapped: `doctor` surveys the real machine, and these
// tests exist to pin the dispatch branch's plumbing, not to re-run the
// survey. `streams.test.ts` and `doctor.test.ts` already cover the survey
// itself.
vi.mock("../commands/doctor", () => ({ doctor: vi.fn() }));

const mockedSync = vi.mocked(sync);
const mockedDoctor = vi.mocked(doctor);
const invoke = (...args: string[]) => run(["node", "onlooker", ...args]);

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
	out = [];
	err = [];
	vi.spyOn(console, "log").mockImplementation((...parts) => {
		out.push(parts.join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...parts) => {
		err.push(parts.join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The exit-code contract is the reason this CLI was rewritten, and until now
 * nothing held it in place. The retired CLI answered every failure the same
 * way, so a script wrapping it could not tell "your wifi dropped" from "the
 * endpoint moved" and retried both forever. 2 means try again; 1 means go look.
 */
describe("run", () => {
	const cases: Array<[Failure, number]> = [
		[{ kind: "transient", message: "the API answered 503" }, 2],
		[{ kind: "unauthorized", message: "that machine token was rejected" }, 1],
		[{ kind: "gone", message: "the endpoint this CLI expects is gone" }, 1],
		[{ kind: "rejected", message: "the API rejected the request" }, 1],
	];

	for (const [failure, code] of cases) {
		it(`exits ${code} on a ${failure.kind} failure, and says why`, async () => {
			mockedSync.mockRejectedValueOnce(new ApiError(failure));
			expect(await invoke("sync")).toBe(code);
			expect(err.join("\n")).toContain(failure.message);
		});
	}

	// Not every throw is an `ApiError`. Reading `.failure` off a plain Error has
	// to produce exit 1, not a crash inside the handler that was meant to report
	// the crash.
	it("exits 1 on an error carrying no failure, without crashing", async () => {
		mockedSync.mockRejectedValueOnce(new Error("EACCES: permission denied"));
		expect(await invoke("sync")).toBe(1);
		expect(err.join("\n")).toContain("EACCES: permission denied");
	});

	it("exits 0 and prints what the command returned", async () => {
		mockedSync.mockResolvedValueOnce("Synced 2 lessons: 2 new.");
		expect(await invoke("sync")).toBe(0);
		expect(out.join("\n")).toContain("Synced 2 lessons: 2 new.");
	});

	for (const flag of ["--help", "-h", "help"]) {
		it(`exits 0 and prints usage on \`${flag}\``, async () => {
			expect(await invoke(flag)).toBe(0);
			expect(out.join("\n")).toContain("onlooker sync");
			expect(err).toEqual([]);
		});
	}

	it("exits 0 and prints usage on a bare invocation", async () => {
		expect(await invoke()).toBe(0);
		expect(out.join("\n")).toContain("onlooker sync");
	});

	// A typo must not print the same bytes to the same stream as `--help`. The
	// exit code already differs, but a person reading the terminal sees only the
	// usage and no reason to think anything went wrong.
	it("names the command it did not recognize, on stderr", async () => {
		expect(await invoke("snyc")).toBe(1);
		expect(err.join("\n")).toMatch(/unknown command: snyc/);
		expect(out).toEqual([]);
	});

	it("lists doctor in the usage text", async () => {
		await invoke("--help");
		expect(out.join("\n")).toContain("onlooker doctor");
	});

	// `doctor` is the one command that hands `run` its own exit code instead
	// of throwing one, so the mapping above cannot stand in for it. Both
	// codes are covered on purpose: a stopped stream turning into exit 1 is
	// the entire reason this command exists, and a regression that dropped
	// `report.code` in favor of the shared `return 0` would still pass every
	// other test in this file.
	it("returns doctor's own code, and prints its report to stdout", async () => {
		mockedDoctor.mockResolvedValueOnce({
			text: "all streams recording",
			code: 0,
		});
		expect(await invoke("doctor")).toBe(0);
		expect(out.join("\n")).toContain("all streams recording");
		expect(err).toEqual([]);
	});

	it("returns doctor's own code when it found something wrong", async () => {
		mockedDoctor.mockResolvedValueOnce({ text: "bursar stopped", code: 1 });
		expect(await invoke("doctor")).toBe(1);
		expect(out.join("\n")).toContain("bursar stopped");
		expect(err).toEqual([]);
	});

	// The real `sync`, not the injected failure: the mapping above is only worth
	// anything if the dispatcher is wired to the actual commands.
	it("carries a real command failure out as an exit code", async () => {
		const previous = process.env.ONLOOKER_DIR;
		process.env.ONLOOKER_DIR = mkdtempSync(join(tmpdir(), "onlooker-cli-"));
		try {
			expect(await invoke("sync")).toBe(1);
			expect(err.join("\n")).toMatch(/onlooker link/);
		} finally {
			if (previous === undefined) delete process.env.ONLOOKER_DIR;
			else process.env.ONLOOKER_DIR = previous;
		}
	});
});
