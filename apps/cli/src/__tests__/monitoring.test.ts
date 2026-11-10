import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "@onlooker/monitoring-sentry/node";
import { describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { configPath, writeConfig } from "../config";
import { buildEnvironment, reportCrash } from "../monitoring";

const DSN = "https://public@o1.ingest.sentry.io/1";

function machine(crashReports?: boolean): NodeJS.ProcessEnv {
	const env = { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-cli-")) };
	writeConfig({ apiBaseUrl: "https://api.onlooker.dev", crashReports }, env);
	return env;
}

function fakeFetch() {
	return vi.fn<FetchLike>(async () => ({
		status: 200,
		headers: { get: () => null },
	}));
}

const crash = () => new TypeError("cannot read properties of undefined");

/**
 * The gate. Each case passes a real DSN and a real adapter, so the only thing
 * standing between the error and `fetch` is the consent check. That is what
 * makes "fetch was not called" mean "consent stopped it" and not "nothing
 * was wired up".
 */
describe("reportCrash, without consent", () => {
	const cases: Array<[string, () => NodeJS.ProcessEnv]> = [
		["nobody chose", () => machine()],
		["it was turned off", () => machine(false)],
		["DO_NOT_TRACK is set", () => ({ ...machine(true), DO_NOT_TRACK: "1" })],
		[
			"ONLOOKER_CRASH_REPORTS=0",
			() => ({ ...machine(true), ONLOOKER_CRASH_REPORTS: "0" }),
		],
		[
			"cli.json cannot be read",
			() => {
				const env = machine(true);
				writeFileSync(configPath(env), "{ not json");
				return env;
			},
		],
	];

	for (const [why, env] of cases) {
		it(`sends nothing when ${why}`, async () => {
			const fetchImpl = fakeFetch();
			expect(
				await reportCrash(
					crash(),
					{ command: "sync" },
					{
						env: env(),
						fetchImpl,
						dsn: DSN,
					},
				),
			).toBe(false);
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	}

	it("sends nothing, and says so, with consent but no DSN", async () => {
		const fetchImpl = fakeFetch();
		expect(
			await reportCrash(
				crash(),
				{ command: "sync" },
				{
					env: machine(true),
					fetchImpl,
					dsn: "",
				},
			),
		).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("reportCrash, with consent", () => {
	it("sends one event with exactly the allowed tags", async () => {
		const fetchImpl = fakeFetch();
		expect(
			await reportCrash(
				crash(),
				{ command: "sync" },
				{
					env: machine(true),
					fetchImpl,
					dsn: DSN,
				},
			),
		).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		const body = fetchImpl.mock.calls[0]?.[1].body as string;
		const lines = body.split("\n");
		const at = lines.findIndex((line) => line.includes('"type":"event"'));
		const event = JSON.parse(lines[at + 1] as string);
		expect(event.release).toBe(`onlooker-cli@${packageJson.version}`);
		expect(event.environment).toBe("development");
		expect(Object.keys(event.tags).sort()).toEqual([
			"arch",
			"command",
			"node",
			"os",
		]);
		expect(event.tags.command).toBe("sync");
		expect(event.tags.node).toMatch(/^\d+$/);
		expect(event.server_name).toBeUndefined();
	});

	// The process exits only once its requests close. A send that never
	// answers must be cut off, not just stopped being waited for, or a crash
	// keeps the terminal for as long as the server cares to stall.
	it("gives up on a send that never answers, and says it was not sent", async () => {
		let signal: AbortSignal | undefined;
		const fetchImpl = vi.fn<FetchLike>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					signal = init.signal;
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		);
		const started = Date.now();
		expect(
			await reportCrash(
				crash(),
				{ command: "sync" },
				{ env: machine(true), fetchImpl, dsn: DSN },
			),
		).toBe(false);
		expect(Date.now() - started).toBeLessThan(2500);
		await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
			timeout: 500,
		});
	});
});

describe("buildEnvironment", () => {
	// Only a release build says production. A bundle someone built locally,
	// or a test, must never page anyone.
	it("is development unless the release build defined it", () => {
		expect(buildEnvironment()).toBe("development");
	});
});

describe("the release build", () => {
	const root = join(__dirname, "..", "..", "..", "..");

	// The define is the only thing that makes an event say production. If the
	// workflow built with plain `build`, every released crash would file as
	// development and the production-only alert would never fire.
	it("is what release-cli.yml builds", () => {
		const workflow = readFileSync(
			join(root, ".github/workflows/release-cli.yml"),
			"utf8",
		);
		expect(workflow).toContain("pnpm --filter @onlooker/cli build:release");
	});

	it("defines the environment as production", () => {
		expect(packageJson.scripts["build:release"]).toContain(
			`__ONLOOKER_ENVIRONMENT__='"production"'`,
		);
	});
});
