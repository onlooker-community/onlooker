import { createRecordingMonitor } from "@onlooker/monitoring/testing";
import { describe, expect, it } from "vitest";
import { heartbeatTargets, runHeartbeat } from "./heartbeat";
import type { WorkerEnv } from "./types";

/** A D1 that answers one row, which is what the heartbeat asks it for. */
const readableDb = {
	prepare: () => ({ first: async () => ({ ok: 1 }) }),
} as unknown as WorkerEnv["DB"];

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
	return {
		JWT_SECRET: "x".repeat(32),
		TOKEN_EXPIRY_MINUTES: "15",
		REFRESH_TOKEN_EXPIRY_DAYS: "30",
		DB: readableDb,
		CORS_ORIGIN: "https://app.onlooker.dev",
		EMAIL_FROM: "Onlooker <noreply@onlooker.dev>",
		APP_BASE_URL: "https://app.onlooker.dev",
		ENVIRONMENT: "production",
		...overrides,
	};
}

/** A fetch that answers each URL with a status from the table, 200 otherwise. */
function fetcherReturning(statuses: Record<string, number>) {
	const seen: string[] = [];
	const fetcher = async (input: string | URL): Promise<Response> => {
		const url = String(input);
		seen.push(url);
		return new Response(null, { status: statuses[url] ?? 200 });
	};
	return { fetcher, seen };
}

describe("heartbeatTargets", () => {
	// Four checks, mirroring the unauthenticated half of scripts/heartbeat.sh.
	// The deep link is the load-bearing one: this project once served 404 for
	// every route except /, through several deploys, and an apex-only check
	// stayed green throughout because / is a file on disk and cannot fail that
	// way.
	it("checks a deep link, not just the apex", () => {
		const urls = heartbeatTargets(envWith()).map((t) => t.url);

		expect(urls).toContain("https://app.onlooker.dev/");
		expect(urls).toContain("https://app.onlooker.dev/login");
	});

	it("derives the web app from APP_BASE_URL rather than hard-coding it", () => {
		const urls = heartbeatTargets(
			envWith({ APP_BASE_URL: "https://app-staging.onlooker.dev" }),
		).map((t) => t.url);

		expect(urls).toContain("https://app-staging.onlooker.dev/login");
		expect(urls.every((u) => !u.includes("//app.onlooker.dev"))).toBe(true);
	});

	// A trailing slash on APP_BASE_URL would otherwise produce
	// https://app.onlooker.dev//login, which the web worker serves as the SPA
	// fallback - a 200 that proves nothing.
	it("does not double the slash when APP_BASE_URL has one", () => {
		const urls = heartbeatTargets(
			envWith({ APP_BASE_URL: "https://app.onlooker.dev/" }),
		).map((t) => t.url);

		expect(urls).toContain("https://app.onlooker.dev/login");
		expect(urls.some((u) => u.includes("//login"))).toBe(false);
	});
});

describe("runHeartbeat", () => {
	it("reports nothing when every target answers as expected", async () => {
		const monitor = createRecordingMonitor();
		const { fetcher } = fetcherReturning({});

		const results = await runHeartbeat(envWith(), {
			fetch: fetcher,
			monitor: monitor.monitor,
		});

		expect(results.every((r) => r.ok)).toBe(true);
		expect(monitor.exceptions).toEqual([]);
	});

	// One exception for the run, not one per failing target: a total outage
	// fails every check at once, and four issues describing one event is how
	// an alert channel earns a filter rule.
	it("reports a single exception naming every target that failed", async () => {
		const monitor = createRecordingMonitor();
		const { fetcher } = fetcherReturning({
			"https://app.onlooker.dev/": 503,
			"https://app.onlooker.dev/login": 503,
		});

		const results = await runHeartbeat(envWith(), {
			fetch: fetcher,
			monitor: monitor.monitor,
		});

		expect(results.filter((r) => !r.ok)).toHaveLength(2);
		expect(monitor.exceptions).toHaveLength(1);

		const message = String(monitor.exceptions[0]?.error);
		expect(message).toContain("/login");
		expect(message).toContain("503");
	});

	// A network error is an outage, not a reason for the checker to crash. If
	// this throws, the scheduled handler dies and nothing is reported at all -
	// the failure mode is silence, which is the one this exists to remove.
	it("treats a fetch that throws as a failed check, not a crash", async () => {
		const monitor = createRecordingMonitor();
		const fetcher = async () => {
			throw new TypeError("network is unreachable");
		};

		const results = await runHeartbeat(envWith(), {
			fetch: fetcher,
			monitor: monitor.monitor,
		});

		// Every fetched target fails, and the run still completes and reports.
		// The database probe does not use fetch, so it stays healthy - which is
		// the useful shape: "the web app is unreachable but D1 is fine" says
		// something a blanket failure would not.
		expect(results.filter((r) => r.label.startsWith("web app"))).toSatisfy(
			(web: { ok: boolean }[]) => web.length === 2 && web.every((r) => !r.ok),
		);
		expect(results.find((r) => r.label === "api d1 read")?.ok).toBe(true);
		expect(monitor.exceptions).toHaveLength(1);
		expect(String(monitor.exceptions[0]?.error)).toContain("unreachable");
	});

	// D1 is checked through the binding rather than by fetching this Worker's
	// own hostname. A self-fetch would mostly confirm what the cron firing
	// already proved, and a same-zone subrequest that misbehaves would report
	// a false outage every five minutes - which is how an alert gets muted.
	// The binding exercises the dependency the API actually fails on.
	it("reports a database it cannot read", async () => {
		const monitor = createRecordingMonitor();
		const { fetcher } = fetcherReturning({});
		const env = envWith({
			DB: {
				prepare: () => ({
					first: async () => {
						throw new Error("D1_ERROR: no such table");
					},
				}),
			} as unknown as WorkerEnv["DB"],
		});

		const results = await runHeartbeat(env, {
			fetch: fetcher,
			monitor: monitor.monitor,
		});

		const db = results.find((r) => r.label === "api d1 read");
		expect(db?.ok).toBe(false);
		expect(String(monitor.exceptions[0]?.error)).toContain("no such table");
	});

	it("counts a readable database as healthy", async () => {
		const monitor = createRecordingMonitor();
		const { fetcher } = fetcherReturning({});
		const env = envWith({
			DB: {
				prepare: () => ({ first: async () => ({ ok: 1 }) }),
			} as unknown as WorkerEnv["DB"],
		});

		const results = await runHeartbeat(env, {
			fetch: fetcher,
			monitor: monitor.monitor,
		});

		expect(results.find((r) => r.label === "api d1 read")?.ok).toBe(true);
		expect(monitor.exceptions).toEqual([]);
	});
});
